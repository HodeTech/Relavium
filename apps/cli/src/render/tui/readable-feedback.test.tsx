import './force-color.js';
import { cleanup, render } from 'ink-testing-library';
import { Box } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { attemptClipboardWrite } from '../clipboard.js';
import { ChatView } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { formatToolCall, transcriptDocument, wrapTranscript } from './chat-projection.js';
import { stripTerminalControls } from '../sanitize.js';
import { INITIAL_SCROLL } from './scroll.js';
import { selectionText } from './selection.js';
import { displayWidth } from './viewport.js';
import type { TranscriptEntry } from './session-view-model.js';
import { emptyEditor } from './chat-input.js';
import { waitFor } from './harness-util.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from './session-view-model.js';

afterEach(cleanup);

const answer: TranscriptEntry = {
  role: 'assistant',
  text: '# Heading\n\n**bold** [site](https://example.test)\n\n| A | B |\n| --- | --- |\n| 中 | é |',
  summary: { stopReason: 'stop', tokensUsed: { input: 1, output: 2 } },
};

describe('MVP-2 truthful feedback', () => {
  it('projects an actual failed tool result through the store into a failure glyph', () => {
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    const stamp = { sessionId: 's', timestamp: '2026-11-09T00:00:00Z', nodeId: 'n' };
    store.apply({
      ...stamp,
      type: 'agent:tool_call',
      sequenceNumber: 1,
      model: 'm',
      toolId: 'read_file',
      toolInput: {},
    });
    store.apply({
      ...stamp,
      type: 'agent:tool_result',
      sequenceNumber: 2,
      toolId: 'read_file',
      success: false,
      outputSummary: 'private result',
    });
    store.flush();
    const call = store.getSnapshot().state.liveToolCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(formatToolCall(call)).toBe('→ read_file ✗');
    expect(formatToolCall({ ...call, success: true })).toBe('→ read_file ✓');
    expect(formatToolCall({ ...call, resolved: false })).toBe('→ read_file …');
  });

  it('turns a local clipboard failure into a content-free failed outcome', async () => {
    const result = await attemptClipboardWrite(() => {
      throw new Error('opaque-secret-in-native-error');
    }, 'text');
    expect(result).toEqual({ kind: 'failed' });
    expect(JSON.stringify(result)).not.toContain('opaque-secret');
  });

  it.each([true, false])(
    'the copy toast reports sent, never confirmed receipt (color %s)',
    async (color) => {
      const store = createChatStore(color, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
      const capture = render(
        <ChatView
          state={store.getSnapshot().state}
          tick={0}
          nowMs={0}
          color={color}
          editor={emptyEditor()}
          running={false}
          mode="ask"
          reasoningVisible={false}
          copied
        />,
      );
      await waitFor(() => (capture.lastFrame() ?? '').includes('Sent to terminal clipboard'));
      expect(capture.lastFrame()).not.toContain('Copied');
    },
  );

  it.each([true, false])(
    'renders source or semantic rows in both renderers (color %s)',
    async (color) => {
      for (const alternate of [false, true]) {
        const store = createChatStore(color, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
        const state = { ...store.getSnapshot().state, transcript: [answer] };
        const capture = render(
          <Box flexDirection="column" {...(alternate ? { height: 24 } : {})}>
            <ChatView
              state={state}
              tick={0}
              nowMs={0}
              color={color}
              editor={emptyEditor()}
              running={false}
              mode="ask"
              reasoningVisible={false}
              columns={80}
              viewport={
                alternate
                  ? { rows: 24, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }
                  : undefined
              }
            />
          </Box>,
        );
        const drawn = (): string =>
          alternate ? (capture.lastFrame() ?? '') : capture.frames.join('\n');
        await waitFor(() => stripTerminalControls(drawn()).includes('https://example.test'));
        const frame = stripTerminalControls(drawn());
        expect(frame).toContain('Heading');
        expect(frame.includes('**bold**')).toBe(!color);
        expect(frame.includes('┌')).toBe(color);
        expect(frame.split('\n').every((line) => displayWidth(line) <= 80)).toBe(true);
        if (alternate) expect(frame.split('\n').length).toBeLessThanOrEqual(24);
        capture.unmount();
      }
    },
  );

  it('keeps source hatches distinct from rendered selection and sanitized in both', () => {
    const entry: TranscriptEntry = {
      ...answer,
      text: '**中**\t[site](https://real.test)\u001b]52;c;hidden\u0007',
    };
    const source = transcriptDocument([entry]);
    const rows = wrapTranscript([entry], 80, true).filter((line) => line.style === 'assistant');
    expect(source).toContain('**中**\t[site](https://real.test)');
    expect(source).not.toContain('hidden');
    const copied = selectionText(
      rows.map((line) => line.text),
      {
        start: { line: 0, column: 0 },
        end: { line: rows.length - 1, column: 79 },
      },
    );
    expect(copied).toBe(rows.map((line) => line.text).join('\n'));
    expect(copied).toContain('site (https://real.test)');
    expect(copied).not.toMatch(/\t|\*\*|hidden/);
    expect(copied).not.toContain('\u001b');
  });

  it.each([true, false])(
    'the store retains parse context before its live tail and resets at a tool round (color %s)',
    async (color) => {
      const store = createChatStore(color, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
      const stamp = { sessionId: 's', timestamp: '2026-11-09T00:00:00Z', nodeId: 'n' };
      store.apply({
        ...stamp,
        type: 'agent:token',
        sequenceNumber: 1,
        model: 'm',
        token: '```ts\n' + 'x'.repeat(4500) + '**literal**',
      });
      store.flush();
      const snapshot = store.getSnapshot();
      const capture = render(
        <ChatView
          {...snapshot}
          nowMs={0}
          editor={emptyEditor()}
          running
          mode="ask"
          reasoningVisible={false}
          columns={80}
          viewport={{ rows: 24, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }}
        />,
      );
      await waitFor(() => (capture.lastFrame() ?? '').includes('literal'));
      const frame = stripTerminalControls(capture.lastFrame() ?? '');
      expect(frame).toContain('**literal**');
      expect(frame.includes('│')).toBe(color);
      expect(frame).toContain('Esc to stop');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      store.apply({
        ...stamp,
        type: 'agent:tool_call',
        sequenceNumber: 2,
        model: 'm',
        toolId: 'read_file',
        toolInput: {},
      });
      store.apply({
        ...stamp,
        type: 'agent:token',
        sequenceNumber: 3,
        model: 'm',
        token: '# next',
      });
      store.flush();
      expect(store.getSnapshot().markdown.sourceTail()).toBe('# next');
      expect(
        store
          .getSnapshot()
          .markdown.tail(80, 10)
          .map((line) => line.text),
      ).toEqual(['next']);
    },
  );

  it.each([true, false])(
    'keeps streamed blank paragraphs as real rows in both renderers (color %s)',
    async (color) => {
      for (const alternate of [false, true]) {
        const store = createChatStore(color, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
        store.apply({
          sessionId: 's',
          timestamp: '2026-11-10T00:00:00Z',
          nodeId: 'n',
          model: 'm',
          type: 'agent:token',
          sequenceNumber: 1,
          token: 'first\n\nsecond',
        });
        store.flush();
        const capture = render(
          <Box flexDirection="column" {...(alternate ? { height: 24 } : {})}>
            <ChatView
              {...store.getSnapshot()}
              nowMs={0}
              editor={emptyEditor()}
              running
              mode="ask"
              reasoningVisible={false}
              columns={80}
              viewport={
                alternate
                  ? { rows: 24, cols: 80, scroll: INITIAL_SCROLL, onMeasure: () => {} }
                  : undefined
              }
            />
          </Box>,
        );
        await waitFor(() => (capture.lastFrame() ?? '').includes('second'));
        expect(stripTerminalControls(capture.lastFrame() ?? '')).toMatch(/first\n *\nsecond/);
        capture.unmount();
      }
    },
  );
});
