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
import { EMPTY_COMMAND_REASON, UNSHOWABLE_COMMAND_REASON, createChatStore } from './chat-store.js';
import { ChatApp } from './chat-ink.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  APPROVAL_CONFIRM_MIN_MS,
  APPROVAL_SETTLE_MS,
  APPROVAL_TYPEAHEAD_MS,
  type ApprovalGuard,
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
const CTRL_R = '\x12';

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
  approvalGuard?: ApprovalGuard,
) {
  const input = new OwnedTtyInput(),
    stderr = new OwnedTtyOutput();
  output.columns = 80;
  output.rows = 24;
  const store = createChatStore(
    color,
    undefined,
    alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
    approvalGuard === undefined ? undefined : { approvalGuard },
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

/**
 * The product's guards (dwell 400 ms, quiet 300 ms, typeahead 1.5 s, lockout 2 s) are pinned with their real numbers in the store's
 * own tests and once per host below; the rest of this file runs the card with short ones, so a case waits tens of milliseconds
 * and not seconds. The confirm window of the two-step answers (0.8 to 5 s) is a constant and is always real.
 */
const FAST: ApprovalGuard = { settleMs: 50, quietMs: 30, typeaheadMs: 150, lockoutMs: 200 };

describe.each(['chat', 'home'] as const)('the docked command card %s (ADR-0118 §1)', (host) => {
  const fast = () => fixture(host, true, false, new OwnedTtyOutput(), {}, FAST);
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** The card has been on screen past the fast dwell and the keyboard is quiet. */
  const seen = (): Promise<void> => wait(250);
  /** The real guard's numbers, for the cases that pin them. */
  const settle = (): Promise<void> => wait(APPROVAL_SETTLE_MS + 400);
  const confirmWindow = (): Promise<void> => wait(APPROVAL_CONFIRM_MIN_MS + 100);

  /**
   * A chord and then the Enter that would confirm the question it asks, inside the confirm window: if the card wrongly honoured
   * the chord it answers here. (A chord alone only OPENS a question, so asserting nothing after it proves nothing.)
   */
  async function chordThenEnter(f: ReturnType<typeof fixture>, chord: string): Promise<void> {
    f.input.push(chord);
    await confirmWindow();
    f.input.push('\r');
    await wait(250); // the Enter is a key the card ignores: past the fast typeahead window, so the next chord is not refused for it
  }

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
  const shown = async (f: ReturnType<typeof fixture>): Promise<string> => {
    await vi.waitFor(() => expect(f.text()).toContain('Standing:'), { timeout: 5000 });
    return f.lastFrameWith('Standing:') ?? '';
  };

  it('says what the command is, where it stands and where it runs, and words the answers for this command', async () => {
    const f = fast();
    await f.ready();
    open(f, ['npm', 'test'], facts());
    const frame = await shown(f);
    expect(frame).toContain('Run npm test');
    expect(frame).toContain('Standing: not pre-approved \u00b7 Runs in: /work/project');
    expect(frame).toContain(
      '[Ctrl+Y] Allow once   [Ctrl+G] Allow this session   [Ctrl+O] Allow + remember',
    );
    expect(frame).toContain('[v] Full view');
    expect(frame).not.toContain('Allow all');
    expect(frame, 'a command card has no tool-identity row').not.toMatch(/^run_command/mu);
    for (const row of frame.split('\n')) expect(row.length, row).toBeLessThanOrEqual(80);
  });

  it('a command on the project’s allowlist says whose list it is', async () => {
    const f = fast();
    await f.ready();
    open(
      f,
      ['npm', 'test'],
      facts({ standing: 'allowlisted', offers: { session: true, remember: false } }),
    );
    expect(await shown(f)).toContain('Standing: on this project\u2019s allowlist');
  });

  it('Ctrl+O then Enter remembers, under the product’s real guards: the answer reaches the hook as the remember scope', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answers = open(f, ['npm', 'test'], facts());
    await vi.waitFor(() => expect(f.text()).toContain('[Ctrl+O] Allow + remember'));
    await settle();
    f.input.push(CTRL_O);
    await vi.waitFor(() =>
      expect(f.text()).toContain(
        'Press Enter to allow this exact command now and remember it for this project',
      ),
    );
    expect(answers).toEqual([]);
    await confirmWindow();
    f.input.push('\r');
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'approve', scope: 'remember' }]));
    expect(f.errors).toEqual([]);
  });

  it('an Enter that comes too early cancels the question and says nothing was allowed', async () => {
    const f = fast();
    await f.ready();
    const answers = open(f, ['npm', 'test'], facts());
    await shown(f);
    await seen();
    f.input.push(CTRL_O);
    await vi.waitFor(() =>
      expect(f.text()).toContain('Press Enter to allow this exact command now'),
    );
    await wait(200); // inside the 800 ms floor
    f.input.push('\r');
    await vi.waitFor(() => expect(f.text()).toContain('nothing was allowed'));
    expect(answers).toEqual([]);
    expect(f.lastFrameWith('nothing was allowed')).toContain('[Ctrl+Y] Allow once');
  });

  it('Esc while the Remember question waits on the command’s full view cancels it, grants nothing and steps back to the card (ADR-0137 §4)', async () => {
    const f = fast();
    await f.ready();
    const answers = open(f, ['npm', 'test'], facts());
    await shown(f);
    await seen();
    f.input.push('v');
    await vi.waitFor(() => expect(f.store.getSnapshot().review?.screen).toBe('full'));
    await seen();
    f.input.push(CTRL_O);
    await vi.waitFor(() =>
      expect(f.text()).toContain(
        'Press Enter to allow this exact command now and remember it for this project',
      ),
    );
    // The full view's own second row: Esc steps back here (the card's "Esc stops the turn" would be false), Ctrl+C stops.
    await vi.waitFor(() =>
      expect(f.text()).toContain(
        'Enter confirms · any other key cancels · Esc back · Ctrl+C stops the turn',
      ),
    );
    f.input.push('\x1b');
    await vi.waitFor(() => expect(f.store.getSnapshot().review?.screen).toBe('card'));
    expect(answers, 'cancelling the question and stepping back grants nothing').toEqual([]);
    expect(f.store.getSnapshot().approval).toBeDefined();
    await confirmWindow();
    f.input.push('\r');
    await wait(150);
    expect(answers, 'an Enter after the step back confirms nothing').toEqual([]);
    expect(f.store.getSnapshot().approval).toBeDefined();
    expect(f.errors).toEqual([]);
  });

  it('Ctrl+G then Enter is the session answer, and Ctrl+Y allows once', async () => {
    const f = fast();
    await f.ready();
    const session = open(f, ['npm', 'test'], facts());
    await vi.waitFor(() => expect(f.text()).toContain('[Ctrl+G] Allow this session'));
    await seen();
    f.input.push(CTRL_G);
    await vi.waitFor(() =>
      expect(f.text()).toContain('Press Enter to allow this exact command for this session'),
    );
    await confirmWindow();
    f.input.push('\r');
    await vi.waitFor(() => expect(session).toEqual([{ outcome: 'approve', scope: 'always' }]));
    const once = open(f, ['npm', 'test'], facts());
    await vi.waitFor(() => expect(f.store.getSnapshot().approval).toBeDefined());
    await wait(450); // past the lockout after a resolved card
    f.input.push(CTRL_Y);
    await vi.waitFor(() => expect(once).toEqual([{ outcome: 'approve', scope: 'once' }]));
  });

  it('a code carrier says it runs code and has no Remember: the chord and its Enter answer nothing, and Once still works', async () => {
    const f = fast();
    await f.ready();
    const answers = open(
      f,
      ['bash', '-c', 'make deploy'],
      facts({ runsCode: true, offers: { session: true, remember: false } }),
    );
    const frame = await shown(f);
    expect(frame).toContain('Runs code');
    expect(frame).not.toContain('[Ctrl+O]');
    expect(frame).toContain('Remember is not offered');
    await seen();
    await chordThenEnter(f, CTRL_O);
    expect(f.text()).not.toContain('remember it for this project');
    expect(answers).toEqual([]);
    f.input.push(CTRL_Y);
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'approve', scope: 'once' }]));
  });

  it('a command that names a protected path is answered Once only, and says so: Session and Remember answer nothing', async () => {
    const f = fast();
    await f.ready();
    const answers = open(
      f,
      ['cat', '.env'],
      facts({ protectedPath: true, offers: { session: false, remember: false } }),
    );
    const frame = await shown(f);
    expect(frame).toContain('Names a protected path');
    expect(frame).toContain('Allow once only');
    expect(frame).toContain('[Ctrl+Y] Allow once');
    expect(frame).not.toContain('[Ctrl+G]');
    expect(frame).not.toContain('[Ctrl+O]');
    await seen();
    await chordThenEnter(f, CTRL_G);
    await chordThenEnter(f, CTRL_O);
    expect(answers).toEqual([]);
    expect(f.text()).not.toContain('Press Enter to allow');
    f.input.push(CTRL_Y);
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'approve', scope: 'once' }]));
  });

  it('a realistic command of six elements keeps all three answers on the card at 80x24, and a refusal note does not take them away', async () => {
    const f = fast();
    await f.ready();
    const argv = ['npm', 'run', 'test', '--', '--coverage', '--reporter=verbose'];
    open(f, argv, facts());
    const frame = await shown(f);
    for (const argument of argv) expect(frame, argument).toContain(`  ${argument}\n`);
    const keys = '[Ctrl+Y] Allow once   [Ctrl+G] Allow this session   [Ctrl+O] Allow + remember';
    expect(frame).toContain(keys);
    expect(frame).not.toMatch(/more lines|not shown/u);
    // A key typed just before an answer is refused with a note; the note takes the row kept for it, not a row of the command.
    await seen();
    f.input.push('x');
    await wait(20);
    f.input.push(CTRL_G);
    await vi.waitFor(() => expect(f.text()).toContain('Keys were typed just before this answer'));
    const noted = f.lastFrameWith('Keys were typed just before this answer') ?? '';
    expect(noted).toContain(keys);
    for (const argument of argv) expect(noted, argument).toContain(`  ${argument}\n`);
    expect(noted).not.toMatch(/not shown/u);
  });

  it('a longer command offers only Once on the card, says why, and offers every answer in the full view, where Remember then asks', async () => {
    const f = fast();
    await f.ready();
    const argv = [
      'npm',
      'run',
      'test',
      '--',
      '--coverage',
      '--reporter=verbose',
      '--bail',
      '--silent',
    ];
    const answers = open(f, argv, facts());
    const card = await shown(f);
    expect(card).toContain('[Ctrl+Y] Allow once');
    expect(card).not.toContain('[Ctrl+G]');
    expect(card).not.toContain('[Ctrl+O]');
    expect(card.replace(/\n {2}/gu, ' ')).toMatch(/\d rows of this command are not shown/u);
    await seen();
    f.input.push('v');
    await vi.waitFor(() => expect(f.text()).toContain('Review \u00b7 tool run_command'));
    const full = f.lastFrameWith('Review \u00b7 tool run_command') ?? '';
    expect(full).toContain('Standing: not pre-approved');
    expect(full).toContain('/work/project');
    for (const argument of ['--silent', '--coverage'])
      expect(full, argument).toContain(`  ${argument}\n`);
    expect(full).toContain(
      '[Ctrl+Y] Allow once   [Ctrl+G] Allow this session   [Ctrl+O] Allow + remember',
    );
    expect(full, 'a command is not held to the file tools’ path rules, and says so').toContain(
      'Approving runs exactly this command; file-tool path rules do not limit it.',
    );
    expect(full).not.toContain('cannot override protected-path');
    await wait(APPROVAL_TYPEAHEAD_MS + 300); // `v` is a foreign key: the typeahead window
    f.input.push(CTRL_O);
    await vi.waitFor(() =>
      expect(f.text()).toContain('Press Enter to allow this exact command now'),
    );
    expect(answers).toEqual([]);
    await confirmWindow();
    f.input.push('\r');
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'approve', scope: 'remember' }]));
  });

  it('a credential-shaped argument must be revealed first: the card says so, no approving answer counts, and revealing it unlocks Once', async () => {
    const f = fast();
    await f.ready();
    const secret = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
    const answers = open(f, ['curl', '-H', `Authorization: Bearer ${secret}`], facts());
    const frame = await shown(f);
    expect(frame.replace(/\n {2}/gu, ' ')).toContain('Press [v], then [r] to inspect them');
    expect(frame).toContain('(Allow is locked until you read the whole command)');
    expect(frame).not.toContain('[Ctrl+Y]');
    expect(frame).not.toContain('[Ctrl+O]');
    expect(f.text(), 'the credential itself never reached the terminal').not.toContain(
      'sk-ant-api03-A1b2',
    );
    await seen();
    f.input.push(CTRL_Y);
    await wait(60);
    await chordThenEnter(f, CTRL_G);
    await chordThenEnter(f, CTRL_O);
    expect(answers).toEqual([]);
    // Reading it (the full view, then reveal) is what unlocks the answers.
    f.input.push('v');
    await vi.waitFor(() => expect(f.text()).toContain('Review \u00b7 tool run_command'));
    await wait(60);
    f.input.push('r');
    await wait(APPROVAL_TYPEAHEAD_MS + 300);
    f.input.push(CTRL_Y);
    await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'approve', scope: 'once' }]));
  });

  it('control characters in an argument are shown as visible escapes, never sent to the terminal', async () => {
    const f = fast();
    await f.ready();
    open(f, ['echo', 'a\u001b[31mb', 'x\u0007y'], facts());
    const frame = await shown(f);
    expect(frame).toContain('  a<U+001B>[31mb\n');
    expect(frame).toContain('  x<U+0007>y\n');
    expect(f.text()).not.toContain('a\u001b[31mb');
    expect(f.text()).not.toContain('x\u0007y');
  });

  it('an empty argument is a row that says so, not a blank one', async () => {
    const f = fast();
    await f.ready();
    open(f, ['echo', '', 'x'], facts(), preview(['echo', '', 'x'], "echo '' x"));
    const frame = await shown(f);
    expect(frame).toContain('  (empty)\n');
    expect(frame).toContain("Run echo '' x");
  });

  it('a command’s title that wraps continues under the command, not at the margin of the argument rows below', async () => {
    const f = fast();
    await f.ready();
    const argv = [
      'echo',
      ...Array.from({ length: 7 }, (_, i) => `argument-number-${String(i)}-long`),
    ];
    open(f, argv, facts());
    const frame = await shown(f);
    const rows = frame.split('\n');
    const title = rows.findIndex((row) => row.startsWith('Run echo'));
    expect(title).toBeGreaterThanOrEqual(0);
    expect(rows[title + 1], 'the continuation is indented by the verb').toMatch(/^ {4}\S/u);
  });

  it('a command too long to show keeps every approving answer locked until it has been read', async () => {
    const f = fast();
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
    await seen();
    f.input.push(CTRL_Y);
    await wait(60);
    await chordThenEnter(f, CTRL_G);
    await chordThenEnter(f, CTRL_O);
    expect(answers, 'no approving answer counted while the command was unread').toEqual([]);
  });

  it('while the reason box is open the card drops its plain fact rows and keeps its warnings, inside the dock', async () => {
    const f = fast();
    await f.ready();
    const answers = open(
      f,
      ['bash', '-c', 'make deploy'],
      facts({ runsCode: true, offers: { session: true, remember: false } }),
    );
    await shown(f);
    await seen();
    f.input.push(CTRL_R);
    await vi.waitFor(() => expect(f.text()).toContain('Reason to deny'));
    f.input.push('n');
    await wait(100);
    const frame = f.lastFrameWith('Reason to deny: n') ?? '';
    expect(frame).toContain('Runs code');
    expect(frame).not.toContain('Standing:');
    expect(frame).not.toContain('Runs in:');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    f.input.push('\u001b'); // Esc closes the box first; the card is still open
    await vi.waitFor(() => expect(f.lastFrameWith('Standing:')).toBeDefined());
    expect(answers).toEqual([]);
  });
});

describe.each(['chat', 'home'] as const)(
  'a command the review document cannot hold %s (ADR-0118 §1)',
  (host) => {
    const wait = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const manyArguments = ['echo', ...Array.from({ length: 70 }, (_, i) => `a${String(i)}`)];

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
    const blocked = async (f: ReturnType<typeof fixture>) => {
      await vi.waitFor(() => expect(f.lastFrameWith('A command is waiting')).toBeDefined(), {
        timeout: 5000,
      });
      return (f.lastFrameWith('A command is waiting') ?? '').replace(/\s+/gu, ' ');
    };
    const fast = () => fixture(host, true, false, new OwnedTtyOutput(), {}, FAST);
    const denied = [{ outcome: 'reject', denialClass: 'mode', reason: UNSHOWABLE_COMMAND_REASON }];

    it('a preview that holds nothing is refused before any card opens: nobody approves an argv they cannot see', async () => {
      const empty = { callId: 'call', preview: { kind: 'operation', fields: [] } } satisfies {
        callId: string;
        preview: ToolPreview;
      };
      const blank = {
        callId: 'call',
        preview: { kind: 'operation', target: '  ', fields: [{ name: '', value: ' ' }] },
      } satisfies { callId: string; preview: ToolPreview };
      for (const held of [undefined, empty, blank]) {
        const f = fast();
        await f.ready();
        const answer = await f.store.requestApproval(
          request(['echo', 'x']),
          true,
          undefined,
          held,
          facts(),
        );
        expect(answer).toEqual({
          outcome: 'reject',
          denialClass: 'mode',
          reason: EMPTY_COMMAND_REASON,
        });
        expect(f.lastFrameWith('Allow once')).toBeUndefined();
        expect(f.lastFrameWith('A command is waiting')).toBeUndefined();
      }
    });

    it('more than 63 arguments is a blocked card that says why: no approving answer counts, not even a chord with its Enter, and Deny still does', async () => {
      const f = fast();
      await f.ready();
      const answers = open(f, manyArguments);
      const frame = await blocked(f);
      expect(frame).toContain('it is too large for this card to show');
      expect(frame).toContain('it cannot be approved here');
      expect(frame).toContain('Denying tells the model to run it as smaller commands');
      await wait(250);
      f.input.push(CTRL_Y);
      for (const chord of [CTRL_G, CTRL_O]) {
        await wait(60);
        f.input.push(chord);
        // In the confirm window, so a card that wrongly honoured the chord would answer here.
        await wait(APPROVAL_CONFIRM_MIN_MS + 100);
        f.input.push('\r');
      }
      await wait(300);
      expect(answers, 'nothing approved the unshowable command').toEqual([]);
      f.input.push(CTRL_N);
      await vi.waitFor(() => expect(answers).toEqual(denied));
    });

    it('an argument over 4,096 characters is blocked the same way, and so is one that is 4,096 UTF-16 units of emoji', async () => {
      for (const argument of ['x'.repeat(5000), '\u{1F600}'.repeat(2100)]) {
        const f = fast();
        await f.ready();
        const answers = open(f, ['echo', argument]);
        await blocked(f);
        await wait(250);
        f.input.push(CTRL_Y);
        await wait(300);
        expect(answers).toEqual([]);
        f.input.push(CTRL_N);
        await vi.waitFor(() => expect(answers).toEqual(denied));
      }
    });

    it('the model is told the host’s limit as a mode refusal, never as the person’s words', async () => {
      const f = fast();
      await f.ready();
      const answers = open(f, manyArguments);
      await blocked(f);
      f.input.push(CTRL_N);
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      expect(answers[0]).toMatchObject({ outcome: 'reject', denialClass: 'mode' });
    });

    it('Esc on a blocked card rejects it (and stops the turn), like on any card', async () => {
      const f = fast();
      await f.ready();
      const answers = open(f, manyArguments);
      await blocked(f);
      await wait(250);
      f.input.push('\u001b');
      await vi.waitFor(() => expect(answers).toEqual([{ outcome: 'reject' }]));
    });

    it('[v] opens nothing on a blocked card: its full view would be the same refusal on a blank screen', async () => {
      const f = fast();
      await f.ready();
      const answers = open(f, manyArguments);
      await blocked(f);
      await wait(250);
      f.input.push('v');
      await wait(200);
      expect(f.text()).not.toContain('Review · tool run_command');
      expect(answers).toEqual([]);
    });

    it('the largest command the document can hold (64 rows) is still a card, not a blocked one', async () => {
      const f = fast();
      await f.ready();
      open(f, ['echo', ...Array.from({ length: 63 }, () => 'a')]);
      await vi.waitFor(() => expect(f.lastFrameWith('Standing:')).toBeDefined(), {
        timeout: 5000,
      });
      expect(f.text()).not.toContain('A command is waiting');
    });
  },
);
