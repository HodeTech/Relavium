/**
 * The command card, mounted for real in both hosts that draw it (ADR-0118 §1): the standing and the directory sit with the
 * warnings, the grants are worded for THIS command, `Ctrl+O` then Enter remembers it, a code carrier or a protected path has
 * fewer answers, and a command too long to show keeps every approving answer locked until it has been read.
 */
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApprovalRequest, ToolPreview } from '@relavium/core';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import type { ClipboardWriter } from '../clipboard.js';
import type { SuspendPort } from '../suspend.js';
import { UNSHOWABLE_COMMAND_REASON, createChatStore } from './chat-store.js';
import { ChatApp } from './chat-ink.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { APPROVAL_CONFIRM_MIN_MS, APPROVAL_SETTLE_MS } from './tool-review-model.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const CTRL_Y = '\x19';
const CTRL_O = '\x0f';
const CTRL_G = '\x07';
const CTRL_N = '\x0e';

const request = (argv: readonly string[]): ToolApprovalRequest => ({
  toolId: 'run_command',
  action: 'process',
  preview: { command: argv.join(' ') },
  unredactedPreview: { command: argv.join(' ') },
  argv,
  commandAdmitted: false,
});
/** What `run_command`'s own preview produces: the whole quoted line as the target and one row per argument. */
const preview = (argv: readonly string[], quoted = argv.join(' ')): ToolPreview => ({
  kind: 'operation',
  target: quoted,
  fields: argv.map((value, index) => ({
    name: index === 0 ? 'program' : `argument ${String(index)}`,
    value,
  })),
});
const facts = (change: Partial<CommandCardFacts> = {}): CommandCardFacts => ({
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session: true, remember: true },
  ...change,
});

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
  const submitted: string[] = [];
  const aborts = { count: 0 };
  const session = {
    store,
    sessionId: 's',
    processLine: (line: string) => {
      submitted.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit' as const,
    onAbort: () => {
      aborts.count += 1;
    },
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
          onSubmit: (message: string) => {
            submitted.push(message);
            return Promise.resolve();
          },
          shouldStop: () => false,
          onExit: () => {},
          onError: (error) => errors.push(error),
          onModeChange: () => {},
          onAbort: () => {
            aborts.count += 1;
          },
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
    submitted.length = 0; // the Home's first message (`h`) started the chat; only what comes after is under test
  };
  return {
    input,
    output,
    store,
    errors,
    submitted,
    aborts,
    ready,
    text: () => output.frames.join(''),
    /** The most recent complete frame (control sequences stripped) that contains `needle`. */
    lastFrameWith: (needle: string): string | undefined =>
      output.frames
        // eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
        .map((frame) => frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, ''))
        .filter((frame) => frame.includes(needle))
        .at(-1),
    resize: (cols: number, rows: number) => {
      output.columns = cols;
      output.rows = rows;
      output.emit('resize');
    },
  };
}

describe.each(['chat', 'home'] as const)('the docked command card %s (ADR-0118 §1)', (host) => {
  const settle = (): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, APPROVAL_SETTLE_MS + 400));
  const confirmWindow = (): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, APPROVAL_CONFIRM_MIN_MS + 100));
  const pause = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 60));

  function open(
    f: ReturnType<typeof fixture>,
    argv: readonly string[],
    c: CommandCardFacts,
    p = preview(argv),
  ) {
    const answers: unknown[] = [];
    void f.store
      .requestApproval(
        request(argv),
        c.offers.session,
        undefined,
        { callId: 'call', preview: p },
        c,
      )
      .then((answer) => answers.push(answer))
      .catch(() => undefined); // a card still open when the host closes is cancelled, which is not an answer
    return answers;
  }

  it('says what the command is, where it stands and where it runs, and words the answers for this command', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    open(f, ['npm', 'test'], facts());
    await vi.waitFor(() => expect(f.text()).toContain('Standing: not pre-approved'));
    const frame = f.lastFrameWith('Standing: not pre-approved') ?? '';
    expect(frame).toContain('Run npm test');
    expect(frame).toContain('Runs in: /work/project');
    expect(frame).toContain(
      '[Ctrl+Y] Allow once   [Ctrl+G] Allow for this session   [Ctrl+O] Remember',
    );
    expect(frame).toContain('[v] Full view');
    expect(frame).not.toContain('Allow all');
    for (const row of frame.split('\n')) expect(row.length, row).toBeLessThanOrEqual(80);
  });

  it('Ctrl+O then Enter remembers: the answer reaches the hook as the remember scope', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answers = open(f, ['npm', 'test'], facts());
    await vi.waitFor(() => expect(f.text()).toContain('[Ctrl+O] Remember'));
    await settle();
    f.input.push(CTRL_O);
    await vi.waitFor(() =>
      expect(f.text()).toContain('Press Enter to remember this exact command for this project'),
    );
    expect(answers).toEqual([]);
    await confirmWindow();
    f.input.push('\r');
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'approve', scope: 'remember' }]));
    expect(f.errors).toEqual([]);
  });

  it('Ctrl+G then Enter is the session answer, and Ctrl+Y allows once', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const session = open(f, ['npm', 'test'], facts());
    await vi.waitFor(() => expect(f.text()).toContain('[Ctrl+G] Allow for this session'));
    await settle();
    f.input.push(CTRL_G);
    await vi.waitFor(() =>
      expect(f.text()).toContain('Press Enter to allow this exact command for this session'),
    );
    await confirmWindow();
    f.input.push('\r');
    await vi.waitFor(() => expect(session).toEqual([{ outcome: 'approve', scope: 'always' }]));
    const once = open(f, ['npm', 'test'], facts());
    await vi.waitFor(() => expect(f.text()).toContain('Standing'));
    await new Promise<void>((resolve) => setTimeout(resolve, 2400)); // the lockout after a resolved card
    f.input.push(CTRL_Y);
    await vi.waitFor(() => expect(once).toEqual([{ outcome: 'approve', scope: 'once' }]));
  });

  it('a code carrier says it runs code and has no Remember', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answers = open(
      f,
      ['bash', '-c', 'make deploy'],
      facts({ runsCode: true, offers: { session: true, remember: false } }),
    );
    await vi.waitFor(() => expect(f.text()).toContain('Runs code'));
    const frame = f.lastFrameWith('Runs code') ?? '';
    expect(frame).not.toContain('[Ctrl+O]');
    expect(frame.replace(/\n {2}/gu, ' ')).toContain('Remember is not offered');
    await settle();
    f.input.push(CTRL_O);
    await pause();
    expect(f.text()).not.toContain('remember this exact command');
    expect(answers).toEqual([]);
    f.input.push(CTRL_N);
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'reject' }]));
  });

  it('a command that names a protected path is answered Once only, and says so', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answers = open(
      f,
      ['cat', '.env'],
      facts({ protectedPath: true, offers: { session: false, remember: false } }),
    );
    await vi.waitFor(() => expect(f.text()).toContain('Names a protected path'));
    const frame = f.lastFrameWith('Names a protected path') ?? '';
    expect(frame.replace(/\n {2}/gu, ' ')).toContain('Only \u201cAllow once\u201d is offered');
    expect(frame).toContain('[Ctrl+Y] Allow once');
    expect(frame).not.toContain('[Ctrl+G]');
    expect(frame).not.toContain('[Ctrl+O]');
    await settle();
    f.input.push(CTRL_G);
    await pause();
    f.input.push(CTRL_O);
    await pause();
    expect(answers).toEqual([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 450)); // the keyboard must be quiet before an affirmative key counts
    f.input.push(CTRL_Y);
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'approve', scope: 'once' }]));
  });

  it('a command too long to show keeps every approving answer locked until it has been read', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const long = [
      'echo',
      ...Array.from({ length: 30 }, (_, i) => `argument-number-${String(i)}-with-some-length`),
    ];
    const answers = open(f, long, facts());
    await vi.waitFor(() => expect(f.text()).toContain('Target shortened'));
    const frame = f.lastFrameWith('Target shortened') ?? '';
    expect(frame).toContain('(Allow is locked until you read the whole command)');
    expect(frame).not.toContain('[Ctrl+O]');
    await settle();
    f.input.push(CTRL_Y);
    f.input.push(CTRL_G);
    f.input.push(CTRL_O);
    await pause();
    expect(answers, 'no approving answer counted while the command was unread').toEqual([]);
  });
});

describe.each(['chat', 'home'] as const)(
  'a command the review document cannot hold %s (ADR-0118 §1)',
  (host) => {
    const settle = (): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, APPROVAL_SETTLE_MS + 400));

    it.each([
      [
        'more than 63 arguments',
        ['echo', ...Array.from({ length: 70 }, (_, i) => `a${String(i)}`)],
      ],
      ['an argument over 4,096 characters', ['echo', 'x'.repeat(5000)]],
    ])('%s is a blocked card: no approving answer counts, Deny still does', async (_what, argv) => {
      const f = fixture(host, true, false);
      await f.ready();
      const answers: unknown[] = [];
      void f.store
        .requestApproval(
          request(argv),
          true,
          undefined,
          { callId: 'call', preview: preview(argv) },
          facts(),
        )
        .then((answer) => answers.push(answer))
        .catch(() => undefined);
      await vi.waitFor(() => expect(f.store.getSnapshot().approval).toBeDefined());
      await settle();
      for (const chord of [CTRL_Y, CTRL_G, CTRL_O]) {
        f.input.push(chord);
        await new Promise<void>((resolve) => setTimeout(resolve, 450));
      }
      f.input.push('\r');
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      expect(answers, 'nothing approved the unshowable command').toEqual([]);
      f.input.push(CTRL_N);
      await vi.waitFor(() =>
        expect(answers).toEqual([{ outcome: 'reject', reason: UNSHOWABLE_COMMAND_REASON }]),
      );
    });
  },
);
