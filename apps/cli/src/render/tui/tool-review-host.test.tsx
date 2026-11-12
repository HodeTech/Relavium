import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolPreview } from '@relavium/core';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createChatStore } from './chat-store.js';
import { ChatApp } from './chat-ink.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { reviewInspected } from './tool-review-model.js';
import { bracketed } from './harness-util.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
const request = {
  toolId: 'write_file',
  action: 'fs_write' as const,
  preview: { path: 'safe.txt' },
  unredactedPreview: { path: 'safe.txt' },
};
const preview: ToolPreview = {
  kind: 'operation',
  target: 'safe.txt',
  fields: [],
  diff: {
    before: '',
    after: 'Bearer sk-proj-abcdefghijklmnopqrstuvw\n',
    beforeEndings: 'empty',
    afterEndings: 'lf',
    stats: { addedLines: 1, removedLines: 0, beforeBytes: 0, afterBytes: 39 },
    lines: [
      {
        kind: 'added',
        text: 'Bearer sk-proj-abcdefghijklmnopqrstuvw',
        ending: 'lf',
        after: { line: 1, start: 0, end: 39 },
      },
    ],
  },
};

function fixture(
  host: 'chat' | 'home',
  alternate: boolean,
  color: boolean,
  output = new OwnedTtyOutput(),
) {
  const input = new OwnedTtyInput(),
    stderr = new OwnedTtyOutput();
  output.columns = 80;
  output.rows = 24;
  const store = createChatStore(
    color,
    undefined,
    alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
  );
  const errors: unknown[] = [];
  const session = {
    store,
    sessionId: 's',
    processLine: async () => {},
    shouldStop: () => false,
    stopReason: () => 'exit' as const,
    teardown: async () => {},
  };
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => Promise.resolve(session),
    homeStore: {
      read: () => ({
        attention: { gates: [], failedRuns: [] },
        recentSessions: [],
        recentRuns: [],
        recentAgents: [],
        unreadableRunIds: [],
        isEmpty: true,
      }),
    },
    onExit: () => {},
    onError: (error) => errors.push(error),
  });
  const tree =
    host === 'chat'
      ? createElement(ChatApp, {
          store,
          onSubmit: async () => {},
          shouldStop: () => false,
          onExit: () => {},
          onError: (error) => errors.push(error),
          onModeChange: () => {},
          alternateScreen: alternate,
        })
      : createElement(RootApp, {
          controller,
          nowMs: () => 0,
          color,
          getSize: () => ({ cols: output.columns, rows: output.rows }),
          subscribeResize: (callback) => {
            output.on('resize', callback);
            return () => {
              output.off('resize', callback);
            };
          },
          alternateScreen: alternate,
        });
  const instance = render(tree, {
    stdin: input,
    stdout: output,
    stderr,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: alternate,
  });
  cleanups.push(() => {
    store.sealToolPreviews();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  const ready = async () => {
    if (host === 'home') {
      controller.handleKey('h', {});
      controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  };
  return {
    input,
    output,
    store,
    errors,
    ready,
    text: () => output.frames.join(''),
    resize: (cols: number, rows: number) => {
      output.columns = cols;
      output.rows = rows;
      output.emit('resize');
    },
  };
}

describe.each(['chat', 'home'] as const)('shared review host %s', (host) => {
  it.each([true, false])(
    'keeps masked edits unapprovable before deliberate flushed inspection, alternate=%s',
    async (alternate) => {
      const f = fixture(host, alternate, false);
      await f.ready();
      let answered = false;
      const answer = f.store
        .requestApproval(request, true, undefined, { callId: 'session-tool:1:0', preview })
        .then((value) => {
          answered = true;
          return value;
        });
      await vi.waitFor(() => expect(f.text()).toContain('Review tool operation'));
      f.input.push('y');
      f.input.push(bracketed('ry'));
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(answered).toBe(false);
      expect(f.text()).not.toContain('abcdefghijkl');
      f.input.push('v');
      await vi.waitFor(() => expect(f.store.getSnapshot().review?.screen).toBe('full'));
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      f.input.push('r');
      f.input.push('y');
      expect(answered).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      if (f.store.getSnapshot().review?.reveal !== true) f.input.push('r');
      await vi.waitFor(() => expect(reviewInspected(f.store.getSnapshot().review!)).toBe(true));
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      f.input.push('y');
      expect(await answer).toEqual({ outcome: 'approve', scope: 'once' });
      expect(f.errors).toEqual([]);
    },
  );
  it.each([true, false])(
    'refuses hidden keys and stale resize evidence, color=%s',
    async (color) => {
      const f = fixture(host, true, color);
      await f.ready();
      f.resize(79, 23);
      let answered = false;
      const answer = f.store
        .requestApproval(request, false, undefined, {
          callId: 'current',
          preview: { kind: 'saved-result', target: 'safe.txt', fields: [] },
        })
        .then((value) => {
          answered = true;
          return value;
        });
      f.input.push('y');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(answered).toBe(false);
      f.resize(80, 24);
      f.input.push('y');
      expect(answered).toBe(false);
      await vi.waitFor(() => expect(f.text()).toContain('Deliver saved result'));
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      f.input.push('a');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(answered).toBe(false);
      f.input.push('y');
      expect(await answer).toEqual({ outcome: 'approve', scope: 'once' });
    },
  );
});

class HeldOutput extends OwnedTtyOutput {
  held = false;
  blockedWrite: (() => void) | undefined;
  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    super._write(
      chunk,
      encoding,
      this.held
        ? () => {
            this.blockedWrite = () => callback();
          }
        : callback,
    );
  }
  override _writev(
    chunks: Array<{ chunk: unknown; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    let index = 0;
    const next = (): void => {
      const part = chunks[index++];
      if (part === undefined) callback();
      else this._write(part.chunk, part.encoding, next);
    };
    next();
  }
  release(): void {
    this.held = false;
    const pending = this.blockedWrite;
    this.blockedWrite = undefined;
    pending?.();
  }
}
describe.each(['chat', 'home'] as const)('flushed review custody %s', (host) => {
  it('waits for actual stdout completion and rejects a stale card key', async () => {
    const output = new HeldOutput();
    const f = fixture(host, true, false, output);
    await f.ready();
    output.held = true;
    let answered = false;
    const first = f.store
      .requestApproval(request, false, undefined, {
        callId: 'first',
        preview: { kind: 'operation', target: 'first.txt', fields: [] },
      })
      .then((value) => {
        answered = true;
        return value;
      });
    await vi.waitFor(() => expect(output.blockedWrite).toBeDefined());
    f.input.push('y');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(answered).toBe(false);
    output.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await vi.waitFor(() => {
      f.input.push('y');
      expect(answered, f.text()).toBe(true);
    });
    expect(await first).toEqual({ outcome: 'approve', scope: 'once' });
    let secondDone = false;
    const second = f.store
      .requestApproval(request, false, undefined, {
        callId: 'second',
        preview: { kind: 'saved-result', target: 'second.txt', fields: [] },
      })
      .then((value) => {
        secondDone = true;
        return value;
      });
    f.input.push('y');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(secondDone).toBe(false);
    await vi.waitFor(() => expect(f.text()).toContain('second.txt'));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await vi.waitFor(() => {
      f.input.push('n');
      expect(secondDone).toBe(true);
    });
    expect(await second).toEqual({ outcome: 'reject' });
  });
});
