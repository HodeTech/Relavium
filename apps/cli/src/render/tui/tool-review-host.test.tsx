import { render } from 'ink';
import { createSuspendPort, type SuspendPort } from '../suspend.js';
import type { ClipboardWriter } from '../clipboard.js';
import { toolReviewIdentity } from './tool-review-view.js';
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
  ports: { suspendPort?: SuspendPort; reviewClipboard?: ClipboardWriter } = {},
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
          ...ports,
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
          ...ports,
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

describe.each(['chat', 'home'] as const)('review identity and explicit copy %s', (host) => {
  it.each(['notify', 'read_clipboard', 'mcp:server:custom'])(
    'names undeclared %s without rendering argument values',
    async (toolId) => {
      const f = fixture(host, true, false);
      await f.ready();
      const answer = f.store.requestApproval(
        {
          ...request,
          toolId,
          preview: { path: 'NEVER_SHOW_ARGUMENTS' },
          unredactedPreview: { path: 'NEVER_SHOW_ARGUMENTS' },
        },
        true,
      );
      await vi.waitFor(() => expect(f.text()).toContain(`tool ${toolId}`));
      expect(f.text()).toContain('action fs_write');
      expect(f.text()).not.toContain('NEVER_SHOW_ARGUMENTS');
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      f.input.push('a');
      expect(await answer).toEqual({ outcome: 'approve', scope: 'always' });
    },
  );
  it('fails closed when escaped identity exceeds the mandatory row budget', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    let answered = false;
    void f.store
      .requestApproval({ ...request, toolId: 'notify' + '\u202e'.repeat(100) }, true)
      .then(() => {
        answered = true;
      });
    await vi.waitFor(() => expect(f.text()).toContain('Review unavailable'));
    f.input.push('a');
    f.input.push('y');
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(answered).toBe(false);
  });
  it.each([true, false])(
    'copies masked review explicitly after reveal without selection clipboard, alternate=%s',
    async (alternate) => {
      const copied: string[] = [];
      const f = fixture(host, alternate, false, new OwnedTtyOutput(), {
        reviewClipboard: (text) => {
          copied.push(text);
          return { kind: 'written', characters: text.length };
        },
      });
      await f.ready();
      void f.store.requestApproval(request, false, undefined, { callId: 'copy', preview });
      await vi.waitFor(() => expect(f.text()).toContain('Review tool operation'));
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      f.input.push('v');
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      f.input.push('r');
      await vi.waitFor(() => expect(f.store.getSnapshot().review?.reveal).toBe(true));
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      f.input.push('c');
      await vi.waitFor(() => expect(copied.length).toBe(1));
      expect(copied[0]).toContain('<MASK:');
      expect(copied[0]).not.toContain('abcdefghijkl');
    },
  );
  it('opens retained summary-only details with selected identity and outcome', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    f.store.applyToolLiveEvent({ phase: 'started', callId: 'summary', toolId: 'git_status' });
    f.store.applyToolLiveEvent({
      phase: 'completed',
      callId: 'summary',
      toolId: 'git_status',
      outcome: 'success',
      summary: 'Clean worktree',
    });
    f.store.openDetails();
    await vi.waitFor(() => expect(f.text()).toContain('Enter details'));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    f.input.push('\r');
    await vi.waitFor(() => expect(f.store.getSnapshot().review?.screen).toBe('full'));
    await vi.waitFor(() => expect(f.text()).toContain('Clean worktree'));
    expect(f.text()).toContain('tool git_status');
    expect(f.text()).toContain('outcome success');
    expect(f.text()).toContain('Preview unavailable');
    expect(f.text()).not.toContain('Approval includes masked bytes');
  });
});

it('escapes controls and literal token delimiters in mandatory tool identity', () => {
  const identity = toolReviewIdentity('mcp:<x>\u202e', 'action', 'os', 80);
  expect(identity.valid).toBe(true);
  expect(identity.rows.join('\n')).toContain('tool mcp:<U+003C>x><U+202E>');
  expect(toolReviewIdentity('界'.repeat(100), 'action', 'os', 80).valid).toBe(false);
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
  it('invalidates external suspend entry and requires a fresh flushed inspection after reclaim', async () => {
    const output = new HeldOutput();
    const port = createSuspendPort();
    const f = fixture(host, true, false, output, { suspendPort: port });
    await f.ready();
    let answered = false;
    void f.store
      .requestApproval(request, false, undefined, { callId: 'suspend', preview })
      .then(() => {
        answered = true;
      });
    await vi.waitFor(() => expect(f.text()).toContain('Review tool operation'));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    f.input.push('v');
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    f.input.push('r');
    await vi.waitFor(() => expect(f.store.getSnapshot().review?.reveal).toBe(true));
    await vi.waitFor(() => expect(reviewInspected(f.store.getSnapshot().review!)).toBe(true));
    let regain: (() => void) | undefined;
    let entered = false;
    const suspended = port.current()?.(() => {
      entered = true;
      return new Promise<void>((resolve) => {
        regain = resolve;
      });
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(f.store.getSnapshot().review?.reveal).toBe(false);
    expect(f.store.getSnapshot().review?.inspected).toEqual([]);
    output.held = true;
    regain?.();
    await vi.waitFor(() => expect(output.blockedWrite).toBeDefined());
    f.store.handleReviewInput('y', {});
    expect(answered).toBe(false);
    output.release();
    await suspended;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    f.input.push('y');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(answered).toBe(false);
    expect(f.store.getSnapshot().review?.reveal).toBe(false);
    f.input.push('r');
    await vi.waitFor(() => expect(reviewInspected(f.store.getSnapshot().review!)).toBe(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    f.input.push('y');
    await vi.waitFor(() => expect(answered).toBe(true));
    expect(f.errors).toEqual([]);
  });
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
