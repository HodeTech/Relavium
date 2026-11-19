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
import {
  APPROVAL_CONFIRM_MIN_MS,
  APPROVAL_SETTLE_MS,
  APPROVAL_TYPEAHEAD_MS,
} from './tool-review-model.js';

// Each answer waits out the card's real dwell, quiet and confirm windows, so a case takes seconds, and a blocked card runs several.
vi.setConfig({ testTimeout: 20_000 });

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
/** What `run_command`'s own preview produces: the whole quoted line as the target and one bare value per argument. */
const preview = (argv: readonly string[], quoted = argv.join(' ')): ToolPreview => ({
  kind: 'operation',
  target: quoted,
  fields: argv.map((value) => ({ name: '', value })),
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
    await vi.waitFor(() => expect(f.store.getSnapshot().approval).toBeDefined());
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

  it('a realistic command of five elements keeps all three answers on the card at 80x24', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    open(f, ['npm', 'run', 'test', '--', '--coverage'], facts());
    await vi.waitFor(() => expect(f.text()).toContain('Standing: not pre-approved'));
    const frame = f.lastFrameWith('Standing: not pre-approved') ?? '';
    for (const argument of ['npm', 'run', 'test', '--', '--coverage'])
      expect(frame, argument).toContain(`  ${argument}\n`);
    expect(frame).toContain(
      '[Ctrl+Y] Allow once   [Ctrl+G] Allow for this session   [Ctrl+O] Remember',
    );
    expect(frame).not.toMatch(/more lines|not shown/u);
  });

  it('a longer command offers only Once on the card, says why, and offers all three in the full view, where Remember then asks', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answers = open(
      f,
      ['npm', 'run', 'test', '--', '--coverage', '--reporter=verbose'],
      facts(),
    );
    await vi.waitFor(() => expect(f.text()).toContain('Standing: not pre-approved'));
    const card = f.lastFrameWith('Standing: not pre-approved') ?? '';
    expect(card).toContain('[Ctrl+Y] Allow once');
    expect(card).not.toContain('[Ctrl+G]');
    expect(card).not.toContain('[Ctrl+O]');
    expect(card.replace(/\n {2}/gu, ' ')).toContain('3 rows of this command are not shown');
    await settle();
    f.input.push('v');
    await vi.waitFor(() => expect(f.text()).toContain('Review · tool run_command'));
    const full = f.lastFrameWith('Review · tool run_command') ?? '';
    expect(full).toContain('Standing: not pre-approved');
    expect(full).toContain('Runs in: /work/project');
    for (const argument of ['--reporter=verbose', '--coverage'])
      expect(full, argument).toContain(`  ${argument}\n`);
    expect(full).toContain(
      '[Ctrl+Y] Allow once   [Ctrl+G] Allow for this session   [Ctrl+O] Remember',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, APPROVAL_TYPEAHEAD_MS + 300)); // `v` is a foreign key: the typeahead window
    f.input.push(CTRL_O);
    await vi.waitFor(() =>
      expect(f.text()).toContain('Press Enter to remember this exact command for this project'),
    );
    expect(answers).toEqual([]);
    await confirmWindow();
    f.input.push('\r');
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'approve', scope: 'remember' }]));
  });

  it('a credential-shaped argument must be revealed first: the card says so and no approving answer counts', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const secret = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
    const answers = open(f, ['curl', '-H', `Authorization: Bearer ${secret}`], facts());
    await vi.waitFor(() => expect(f.text()).toContain('Standing: not pre-approved'));
    const frame = f.lastFrameWith('Standing: not pre-approved') ?? '';
    expect(frame.replace(/\n {2}/gu, ' ')).toContain('Press [v], then [r] to inspect them');
    expect(frame).toContain('(Allow is locked until you read the whole command)');
    expect(frame).not.toContain('[Ctrl+Y]');
    expect(frame).not.toContain('[Ctrl+O]');
    expect(f.text(), 'the credential itself never reached the terminal').not.toContain(secret);
    await settle();
    for (const chord of [CTRL_Y, CTRL_G, CTRL_O]) {
      f.input.push(chord);
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
    }
    expect(answers).toEqual([]);
    f.input.push(CTRL_N);
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'reject' }]));
  });

  it('control characters in an argument are shown as visible escapes, never sent to the terminal', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    open(f, ['echo', 'a\u001b[31mb', 'x\u0007y'], facts());
    await vi.waitFor(() => expect(f.text()).toContain('Standing: not pre-approved'));
    const frame = f.lastFrameWith('Standing: not pre-approved') ?? '';
    expect(frame).toContain('  a<U+001B>[31mb\n');
    expect(frame).toContain('  x<U+0007>y\n');
    expect(f.text()).not.toContain('a\u001b[31mb');
    expect(f.text()).not.toContain('x\u0007y');
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
    const wait = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    function open(f: ReturnType<typeof fixture>, argv: readonly string[]) {
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
      return answers;
    }

    it.each([
      [
        'more than 63 arguments',
        ['echo', ...Array.from({ length: 70 }, (_, i) => `a${String(i)}`)],
      ],
      ['an argument over 4,096 characters', ['echo', 'x'.repeat(5000)]],
    ])(
      '%s is a blocked card that says why: no approving answer counts, Deny still does',
      async (_what, argv) => {
        const f = fixture(host, true, false);
        await f.ready();
        const answers = open(f, argv);
        await vi.waitFor(() => expect(f.lastFrameWith('A command is waiting')).toBeDefined());
        const frame = (f.lastFrameWith('A command is waiting') ?? '').replace(/\s+/gu, ' ');
        expect(frame).toContain('it is too large for this card to show');
        expect(frame).toContain('it cannot be approved here');
        expect(frame).toContain('Denying tells the model to run it as smaller commands');
        await settle();
        // Every approving answer, each with the Enter that would confirm a question it had opened (in the confirm window, so a
        // card that wrongly honoured the chord would answer here), and a quiet gap before each so the guards are not what refuses.
        await wait(450);
        f.input.push(CTRL_Y);
        for (const chord of [CTRL_G, CTRL_O]) {
          await wait(450);
          f.input.push(chord);
          await wait(APPROVAL_CONFIRM_MIN_MS + 100);
          f.input.push('\r');
        }
        await wait(600);
        expect(answers, 'nothing approved the unshowable command').toEqual([]);
        f.input.push(CTRL_N);
        await vi.waitFor(() =>
          expect(answers).toEqual([{ outcome: 'reject', reason: UNSHOWABLE_COMMAND_REASON }]),
        );
      },
    );

    it('Esc on a blocked card rejects it (and stops the turn), like on any card', async () => {
      const f = fixture(host, true, false);
      await f.ready();
      const answers = open(f, ['echo', ...Array.from({ length: 70 }, (_, i) => `a${String(i)}`)]);
      await vi.waitFor(() => expect(f.lastFrameWith('A command is waiting')).toBeDefined());
      await settle();
      f.input.push('\u001b');
      await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'reject' }]));
    });

    it('the largest command the document can hold (64 rows) is still a card, not a blocked one', async () => {
      const f = fixture(host, true, false);
      await f.ready();
      open(f, ['echo', ...Array.from({ length: 63 }, () => 'a')]);
      await vi.waitFor(() => expect(f.lastFrameWith('Standing: not pre-approved')).toBeDefined());
      expect(f.text()).not.toContain('A command is waiting');
    });
  },
);
