import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChatMode } from '../../chat/chat-mode.js';
import type { DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import type { UserCommandOutcome } from '@relavium/core';

import type { MentionReader } from './mention.js';

// The paste-boundary markers exactly as ink 6.8's input layer surfaces them (the leading ESC is stripped).
const PASTE_START = '[200~';
const PASTE_END = '[201~';

/** A no-op `/doctor` probe set — the fast-tier probes never throw, so a `/doctor` run reports all-ok. The
 *  `/doctor`-behavior tests below override individual probes; the rest just need a value for the required dep. */
const STUB_DOCTOR_PROBES: DoctorProbes = {
  keychain: () => {},
  config: () => {},
  toolHost: {},
};

/** A real chat store whose snapshot reports `running` — the controller reads `getSnapshot().state.status`. Built
 *  by overriding the live snapshot's status, so it satisfies {@link ChatStoreController} with no unsafe cast. */
const runningStore = (): ChatStoreController => {
  const store = createChatStore(false);
  const snapshot = store.getSnapshot();
  return {
    ...store,
    getSnapshot: () => ({ ...snapshot, state: { ...snapshot.state, status: 'running' } }),
  };
};

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  isEmpty: true,
};

/** A controllable {@link HomeChatSession} fake: records the lines it processes, exposes a teardown spy, and lets a
 *  test script `shouldStop` (the /exit·/cancel signal) and the turn outcome (resolve vs reject). */
function makeSession(
  opts: {
    onProcess?: () => Promise<void>;
    stop?: () => boolean;
    stopReason?: () => 'exit' | 'clear';
    sessionId?: string;
    running?: boolean;
    store?: ReturnType<typeof createChatStore>;
    onAbort?: () => void;
    onModeChange?: (mode: ChatMode) => void;
    mentionReader?: MentionReader;
    runShellCommand?: (command: string, args: readonly string[]) => Promise<UserCommandOutcome>;
  } = {},
): {
  session: HomeChatSession;
  teardown: ReturnType<typeof vi.fn>;
  lines: string[];
  store: ReturnType<typeof createChatStore>;
} {
  const lines: string[] = [];
  const teardown = vi.fn(() => Promise.resolve());
  // A custom store wins; else running ⇒ a status-running store, idle ⇒ a fresh one (the running-gate is false).
  const store = opts.store ?? (opts.running === true ? runningStore() : createChatStore(false));
  const session: HomeChatSession = {
    store,
    sessionId: opts.sessionId ?? 'sess-fake',
    processLine: async (line) => {
      lines.push(line);
      if (opts.onProcess) await opts.onProcess();
    },
    shouldStop: opts.stop ?? (() => false),
    stopReason: opts.stopReason ?? (() => 'exit'),
    ...(opts.onAbort === undefined ? {} : { onAbort: opts.onAbort }),
    ...(opts.onModeChange === undefined ? {} : { onModeChange: opts.onModeChange }),
    ...(opts.mentionReader === undefined ? {} : { mentionReader: opts.mentionReader }),
    ...(opts.runShellCommand === undefined ? {} : { runShellCommand: opts.runShellCommand }),
    teardown,
  };
  return { session, teardown, lines, store };
}

/** Flush the microtask + macrotask queue so the controller's async `startChat`/`processLine` chains settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Type a string into the controller one printable char at a time (each its own `useInput` event). */
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};
const ENTER = { return: true } as const;
const CTRL_C = { ctrl: true } as const;

describe('createHomeController (2.5.B lifecycle / ADR-0054)', () => {
  let homeStore: HomeStore;
  let reads: number;

  beforeEach(() => {
    reads = 0;
    homeStore = {
      read: () => {
        reads += 1;
        return EMPTY;
      },
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('types into the buffer and reflects it in the snapshot', () => {
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    // Assert the WHOLE EditorState (not just .text) so the Home surface's cursor migration is covered too — the
    // cursor tracks the end of the buffer in step 1 (the readline motions that move it off the end land in step 2).
    expect(c.getSnapshot().input).toEqual({ text: 'hi', cursor: 2 });
    c.handleKey('', { backspace: true });
    expect(c.getSnapshot().input).toEqual({ text: 'h', cursor: 1 });
  });

  it('the Home prompt is a first-class line editor: motions / newline / kill via handleKey (2.5.D step 2)', () => {
    // Exercise the shared editor through the CONTROLLER (handleHomeKey → applyEditorAction), not just the reducer,
    // so a dropped case in the grouped edit arm would fail here (ink surfaces have no render-test backstop).
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'abcd');
    c.handleKey('', { leftArrow: true }); // Left: 4 → 3
    c.handleKey('', { leftArrow: true }); // → 2
    expect(c.getSnapshot().input).toEqual({ text: 'abcd', cursor: 2 });
    c.handleKey('X', {}); // insert AT the cursor (mid-buffer), not append-at-end
    expect(c.getSnapshot().input).toEqual({ text: 'abXcd', cursor: 3 });
    c.handleKey('\n', {}); // Ctrl+J: a newline at the cursor
    expect(c.getSnapshot().input).toEqual({ text: 'abX\ncd', cursor: 4 });
    c.handleKey('k', { ctrl: true }); // Ctrl+K: kill to the end of the line (deletes 'cd')
    expect(c.getSnapshot().input).toEqual({ text: 'abX\n', cursor: 4 });
  });

  it('the in-Home chat recalls history with Up/Down and reverse-searches with Ctrl+R (2.5.D step 3)', async () => {
    const made = makeSession();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hello world');
    c.handleKey('', ENTER); // submit records 'hello world' + starts the chat (idle store)
    await flush();
    expect(c.getSnapshot().mode).toBe('chat');

    // Up on the empty prompt is a vertical no-op → history recall of the submitted line; Down restores the draft.
    c.handleKey('', { upArrow: true });
    expect(c.getSnapshot().input).toEqual({ text: 'hello world', cursor: 11 });
    c.handleKey('', { downArrow: true });
    expect(c.getSnapshot().input).toEqual({ text: '', cursor: 0 });

    // Ctrl+R opens reverse-search; the query matches; Enter loads the matched entry into the buffer.
    c.handleKey('r', { ctrl: true });
    expect(c.getSnapshot().search).toEqual({ query: '', matchIndex: null });
    type(c, 'wor');
    expect(c.getSnapshot().search).toEqual({ query: 'wor', matchIndex: 0 });
    c.handleKey('', ENTER);
    expect(c.getSnapshot().search).toBeUndefined();
    expect(c.getSnapshot().input).toEqual({ text: 'hello world', cursor: 11 });
  });

  it('in-Home chat: reverse-search accept resets history nav so a following Down does not clobber it', async () => {
    const made = makeSession();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'alpha');
    c.handleKey('', ENTER); // records 'alpha', starts the chat
    await flush();
    type(c, 'beta');
    c.handleKey('', ENTER); // records 'beta' → history ['alpha','beta']
    expect(made.lines).toEqual(['alpha', 'beta']);
    await flush(); // let the turn settle (ADR-0062: input is gated while a submit is in flight) before navigating

    c.handleKey('', { upArrow: true }); // Up-recall makes history navigation active (navIndex set)
    expect(c.getSnapshot().input.text).toBe('beta');
    c.handleKey('r', { ctrl: true }); // open reverse-search
    type(c, 'al'); // matches 'alpha'
    c.handleKey('', ENTER); // accept 'alpha' — must reset history nav
    expect(c.getSnapshot().input).toEqual({ text: 'alpha', cursor: 5 });
    // Down is now a no-op (nav reset by accept), NOT a historyNext that clobbers 'alpha' with the stale draft.
    c.handleKey('', { downArrow: true });
    expect(c.getSnapshot().input).toEqual({ text: 'alpha', cursor: 5 });
  });

  it('the in-Home chat opens `@` file completion, descends a dir, and queues the accepted file as a chip that expands at submit (2.5.D step 4 / ADR-0061 chip model)', async () => {
    const mentionReader: MentionReader = {
      list: (dir) =>
        Promise.resolve(
          dir === ''
            ? [
                { name: 'src', type: 'directory' as const, path: 'src' },
                { name: 'app.ts', type: 'file' as const, path: 'app.ts' },
              ]
            : [{ name: 'index.ts', type: 'file' as const, path: 'src/index.ts' }],
        ),
      read: (path) => Promise.resolve({ content: `// ${path}`, sizeBytes: 5 }),
    };
    const made = makeSession({ mentionReader });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER); // start the chat (input clears)
    await flush();
    expect(c.getSnapshot().mode).toBe('chat');

    // '@' at the (empty) word boundary opens the completion — loading, and the '@' is NOT inserted into the buffer.
    c.handleKey('@', {});
    expect(c.getSnapshot().mention?.loading).toBe(true);
    expect(c.getSnapshot().input.text).toBe('');
    await flush(); // list('') resolves
    expect(c.getSnapshot().mention?.loading).toBe(false);
    expect(c.getSnapshot().mention?.candidates.map((x) => x.name)).toEqual(['src', 'app.ts']);

    // Enter accepts the selected DIRECTORY (index 0 = src) → descend + re-list.
    c.handleKey('', ENTER);
    expect(c.getSnapshot().mention?.dir).toBe('src');
    await flush(); // list('src') resolves
    expect(c.getSnapshot().mention?.candidates.map((x) => x.name)).toEqual(['index.ts']);

    // Enter accepts the FILE → close + read + insert a compact `@marker` into the buffer + queue a pending FILE
    // attachment (chip). The framed, untrusted content is NOT spliced into the buffer — it expands only at submit.
    c.handleKey('', ENTER);
    expect(c.getSnapshot().mention).toBeUndefined();
    await flush(); // read('src/index.ts') resolves
    expect(c.getSnapshot().input.text).toBe('@src/index.ts '); // the marker, not a framed block
    expect(c.getSnapshot().attachments).toEqual([
      { kind: 'file', path: 'src/index.ts', content: '// src/index.ts', sizeBytes: 5 },
    ]);

    // SUBMIT: the marker's file expands into the nonce-fenced <file> frame sent to the model (a fresh random nonce,
    // open === close — an unforgeable boundary); the buffer + the consumed attachment clear.
    made.lines.length = 0; // isolate the submitted message from the earlier 'hi'
    c.handleKey('', ENTER);
    await flush();
    const framed = made.lines[0]?.match(
      /^@src\/index\.ts \n\n<file id="([0-9a-f]{32})" path="src\/index\.ts">\n\/\/ src\/index\.ts\n<\/file:([0-9a-f]{32})>$/,
    );
    expect(framed).not.toBeNull();
    expect(framed?.[1]).toBe(framed?.[2]); // open nonce === close nonce
    expect(c.getSnapshot().attachments).toEqual([]);
    expect(c.getSnapshot().input.text).toBe('');
  });

  it('`@` completion: Esc restores the typed keystrokes; a mid-word `@` stays literal (2.5.D step 4)', async () => {
    const mentionReader: MentionReader = {
      list: () => Promise.resolve([{ name: 'app.ts', type: 'file' as const, path: 'app.ts' }]),
      read: () => Promise.resolve({ content: 'x', sizeBytes: 1 }),
    };
    const made = makeSession({ mentionReader });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();

    // Open, narrow the filter to 'sr', then Esc — the literal '@sr' is restored (nothing typed is eaten).
    c.handleKey('@', {});
    await flush();
    type(c, 'sr');
    expect(c.getSnapshot().mention?.filter).toBe('sr');
    c.handleKey('', { escape: true });
    expect(c.getSnapshot().mention).toBeUndefined();
    expect(c.getSnapshot().input.text).toBe('@sr');

    // A mid-word '@' (an email/handle) never opens the completion — it appends as a literal char.
    type(c, 'foo');
    c.handleKey('@', {});
    expect(c.getSnapshot().mention).toBeUndefined();
    expect(c.getSnapshot().input.text).toBe('@srfoo@');
  });

  it('`@` accept: a read that resolves AFTER a submit is dropped (never injects into the next message)', async () => {
    // A deferred read: capture its resolver so the test can settle it AFTER a submit.
    let resolveRead: (r: { content: string; sizeBytes: number }) => void = () => {};
    const mentionReader: MentionReader = {
      list: () => Promise.resolve([{ name: 'app.ts', type: 'file' as const, path: 'app.ts' }]),
      read: () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    };
    const made = makeSession({ mentionReader });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER); // start the chat
    await flush();

    c.handleKey('@', {}); // open completion
    await flush(); // list resolves (app.ts)
    c.handleKey('', ENTER); // accept the file → read is now PENDING (deferred)
    expect(c.getSnapshot().mention).toBeUndefined();

    // The user submits a NEW message before the read resolves — the buffer is cleared.
    type(c, 'next message');
    c.handleKey('', ENTER);
    expect(made.lines).toEqual(['hi', 'next message']); // no injected `<file>` block in either

    // NOW the stale read resolves — its injection must be DROPPED (not spliced into the empty next buffer).
    resolveRead({ content: '// app.ts', sizeBytes: 9 });
    await flush();
    expect(c.getSnapshot().input.text).toBe(''); // the buffer stays clean — the stale inject was dropped
  });

  it('a `!`-shell line runs the command (not a message) and carries the output as a pending chip that expands at the next submit (2.5.D step 5 / ADR-0061 chip model)', async () => {
    const ran: UserCommandOutcome = {
      kind: 'ran',
      exitCode: 0,
      stdout: 'a.ts\nb.ts',
      stderr: '',
    };
    const shellCalls: { command: string; args: readonly string[] }[] = [];
    const made = makeSession({
      runShellCommand: (command, args) => {
        shellCalls.push({ command, args });
        return Promise.resolve(ran);
      },
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    made.lines.length = 0; // isolate: only shell/message activity AFTER the chat started

    type(c, '!ls -la');
    c.handleKey('', ENTER);
    await flush();
    // The `!` line was tokenized + run through the runner — NOT sent to the model as a message.
    expect(shellCalls).toEqual([{ command: 'ls', args: ['-la'] }]);
    expect(made.lines).toEqual([]); // no message sent
    // The buffer stays clean — the output is queued as a pending COMMAND attachment (chip) that rides the NEXT
    // message, and a read-only preview is shown via the transcript's notice channel.
    expect(c.getSnapshot().input.text).toBe('');
    expect(c.getSnapshot().attachments).toEqual([
      {
        kind: 'command',
        cmd: { command: 'ls', args: ['-la'] },
        exitCode: 0,
        stdout: 'a.ts\nb.ts',
        stderr: '',
      },
    ]);
    const noticed = made.store
      .getSnapshot()
      .state.transcript.some((e) => e.role === 'notice' && e.text.includes('! ls -la (exit 0)'));
    expect(noticed).toBe(true);

    // The NEXT message expands the carried command into the nonce-fenced <command> frame (a fresh nonce, open ===
    // close); the attachment clears. `made.lines` records the full framed MESSAGE (not the compact display).
    type(c, 'what happened?');
    c.handleKey('', ENTER);
    await flush();
    const framed = made.lines[0]?.match(
      /^what happened\?\n\n<command id="([0-9a-f]{32})" cmd="ls -la" exit="0">\na\.ts\nb\.ts\n<\/command:([0-9a-f]{32})>$/,
    );
    expect(framed).not.toBeNull();
    expect(framed?.[1]).toBe(framed?.[2]); // open nonce === close nonce
    expect(c.getSnapshot().attachments).toEqual([]);
  });

  it('a denied `!`-shell command injects NOTHING and surfaces the actionable allowlist hint (2.5.D step 5)', async () => {
    const made = makeSession({
      runShellCommand: () =>
        Promise.resolve({ kind: 'denied', allowlist: true, message: 'not allowed' }),
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();

    type(c, '!rm -rf /');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().input.text).toBe(''); // nothing injected — the command was denied before any side effect
    // The store carries an actionable, secret-free hint naming the exact allowed_commands line to add.
    const warned = made.store
      .getSnapshot()
      .state.warnings.some((w) => w.includes('allowed_commands') && w.includes('rm -rf /'));
    expect(warned).toBe(true);
  });

  it('a bare `!` (no command) falls through to a normal message send', async () => {
    const made = makeSession({ runShellCommand: () => Promise.reject(new Error('unused')) });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    made.lines.length = 0;

    type(c, '!'); // a bare `!` with no command tokenizes to undefined → a normal message
    c.handleKey('', ENTER);
    await flush();
    expect(made.lines).toEqual(['!']); // sent as a message, not run as a command
  });

  it('gates input WHILE a `!`-command is in flight — a message typed mid-command never reaches sendMessage (no crash)', async () => {
    // A DEFERRED command: it stays pending so we can act while the session is busy (`#status: running`, but the
    // store has no status for it — this is the exact window the crash lived in).
    let resolveCmd: (o: UserCommandOutcome) => void = () => {};
    const onError = vi.fn();
    const made = makeSession({
      runShellCommand: () =>
        new Promise((resolve) => {
          resolveCmd = resolve;
        }),
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError,
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    made.lines.length = 0;

    type(c, '!sleep 9'); // a long-running command
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().shellBusy).toBe(true); // the busy flag is set — input is now gated
    expect(c.getSnapshot().shellCommand).toBe('sleep 9'); // the busy indicator is labeled with the running command

    // The user, seeing an (apparently idle) prompt, types a message + Enter BEFORE the command resolves.
    type(c, 'a normal message');
    c.handleKey('', ENTER);
    await flush();
    // The message is GATED — it never reached sendMessage (no SessionStateError → no onError crash), and the
    // buffer edit itself was ignored (input gated), so nothing was sent.
    expect(made.lines).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(c.getSnapshot().input.text).toBe('');

    // The command resolves → busy clears, the output is queued as a pending command attachment (chip), and the
    // session is usable again. The buffer stays clean (the mid-command typed message was gated).
    resolveCmd({ kind: 'ran', exitCode: 0, stdout: 'done', stderr: '' });
    await flush();
    expect(c.getSnapshot().shellBusy).toBe(false);
    expect(c.getSnapshot().shellCommand).toBeUndefined(); // the busy label clears on settle
    expect(c.getSnapshot().input.text).toBe('');
    expect(c.getSnapshot().attachments).toEqual([
      {
        kind: 'command',
        cmd: { command: 'sleep', args: ['9'] },
        exitCode: 0,
        stdout: 'done',
        stderr: '',
      },
    ]);
  });

  it('gates input WHILE a submit is in flight — a message typed during a turn/compaction never reaches sendMessage (ADR-0062)', async () => {
    // A DEFERRED turn: processLine stays pending (the auto-compaction window — the engine is busy AFTER the view
    // went idle — is exactly this state). A message typed then must be gated, not crash the session.
    let resolveProcess: () => void = () => {};
    const onError = vi.fn();
    const made = makeSession({
      onProcess: () => new Promise<void>((resolve) => (resolveProcess = resolve)),
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError,
    });
    type(c, 'first');
    c.handleKey('', ENTER); // starts the chat + submits 'first' (processLine pending on onProcess)
    await flush();
    expect(c.getSnapshot().submitBusy).toBe(true); // the submit is in flight → input gated

    type(c, 'typed during'); // the user, seeing an idle-looking prompt, types + Enter mid-submit
    c.handleKey('', ENTER);
    await flush();
    expect(made.lines).toEqual(['first']); // GATED — the second line never reached processLine (no crash)
    expect(onError).not.toHaveBeenCalled();

    resolveProcess(); // the submit settles → busy clears, the session usable again
    await flush();
    expect(c.getSnapshot().submitBusy).toBe(false);
  });

  it('`Esc` at an IDLE prompt discards pending attachments — but is a no-op while a `!`-command runs (2.5.D chip model)', async () => {
    // A deferred runner so we can hold a command in flight (busy) and settle it on demand.
    const resolvers: ((o: UserCommandOutcome) => void)[] = [];
    const made = makeSession({
      runShellCommand: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(made.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();

    // Queue one command attachment (run + settle `!ls`).
    type(c, '!ls');
    c.handleKey('', ENTER);
    await flush();
    resolvers[0]?.({ kind: 'ran', exitCode: 0, stdout: 'x', stderr: '' });
    await flush();
    expect(c.getSnapshot().attachments).toHaveLength(1);

    // Start a SECOND, deferred command → the surface is busy again. `Esc` is now the mid-turn abort, NOT the clear
    // affordance, so the pending attachment must SURVIVE.
    type(c, '!sleep 9');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().shellBusy).toBe(true);
    c.handleKey('', { escape: true });
    expect(c.getSnapshot().attachments).toHaveLength(1); // not cleared while busy

    // Settle it (now two chips), then `Esc` at the idle prompt discards ALL pending attachments + notes.
    resolvers[1]?.({ kind: 'ran', exitCode: 0, stdout: 'y', stderr: '' });
    await flush();
    expect(c.getSnapshot().attachments).toHaveLength(2);
    c.handleKey('', { escape: true });
    expect(c.getSnapshot().attachments).toEqual([]);
    const cleared = made.store
      .getSnapshot()
      .state.warnings.some((w) => w.includes('cleared pending attachments'));
    expect(cleared).toBe(true);
  });

  it('a non-empty submit builds a chat, transitions loading→chat, and sends the first message', async () => {
    const made = makeSession();
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hello');
    c.handleKey('', ENTER);
    expect(c.getSnapshot().mode).toBe('loading');
    expect(c.getSnapshot().pendingMessage).toBe('hello'); // echoed under "Starting chat…"
    expect(c.getSnapshot().input.text).toBe(''); // the buffer clears on submit

    await flush();
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().mode).toBe('chat');
    expect(made.lines).toEqual(['hello']); // the first turn streams in the chat region
  });

  it('an empty / whitespace submit stays on the Home and never builds a chat', () => {
    const startChat = vi.fn();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, '   ');
    c.handleKey('', ENTER);
    expect(startChat).not.toHaveBeenCalled();
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().input.text).toBe('');
  });

  it('a build failure routes back to Home with the banner (no session)', async () => {
    const startChat = vi.fn(() => Promise.reject(new Error('no API key for provider')));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().errorText).toBe('no API key for provider');
    expect(c.getSnapshot().session).toBeUndefined();
  });

  it('a turn that throws tears the session down BEFORE propagating onError (never orphans it)', async () => {
    const made = makeSession({ onProcess: () => Promise.reject(new Error('turn-core bug')) });
    const onError = vi.fn();
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError,
    });

    type(c, 'go');
    c.handleKey('', ENTER);
    await flush();

    expect(made.teardown).toHaveBeenCalledTimes(1); // torn down on the error path
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('turn-core bug');
  });

  it('a turn that ends the session (/exit·/cancel) returns to a freshly-read Home', async () => {
    const made = makeSession({ stop: () => true }); // shouldStop ⇒ the turn ended the session
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'bye');
    c.handleKey('', ENTER);
    await flush();

    expect(made.teardown).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().session).toBeUndefined();
    expect(reads).toBeGreaterThanOrEqual(2); // the strip was re-read on return (initial + post-chat)
  });

  it('Ctrl-C on the Home exits cleanly (idempotent — never settles driveHome twice)', () => {
    const onExit = vi.fn();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit,
      onError: vi.fn(),
    });
    c.handleKey('c', CTRL_C);
    c.handleKey('c', CTRL_C); // a second Ctrl-C / a race must not re-fire
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Ctrl-C inside a chat sends /cancel once (cancelFired guards a double)', async () => {
    const made = makeSession();
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    made.lines.length = 0; // drop the first turn

    c.handleKey('c', CTRL_C);
    c.handleKey('c', CTRL_C); // guarded
    expect(made.lines).toEqual(['/cancel']);
  });

  it('exiting mid-build reclaims the just-built session instead of mounting it', async () => {
    let resolveBuild: (s: HomeChatSession) => void = () => undefined;
    const made = makeSession();
    const startChat = vi.fn(() => new Promise<HomeChatSession>((r) => (resolveBuild = r)));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER); // → loading, build pending
    c.handleKey('c', CTRL_C); // user exits while the build is in flight
    resolveBuild(made.session); // the build resolves AFTER the exit
    await flush();

    expect(made.teardown).toHaveBeenCalledTimes(1); // reclaimed, not mounted
    expect(c.getSnapshot().mode).not.toBe('chat');
    expect(made.lines).toEqual([]); // no first message was ever sent
  });

  it('teardownActive tears a live chat down (for the signal handler) and is idempotent vs endChat', async () => {
    const made = makeSession();
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();

    await c.teardownActive();
    await c.teardownActive(); // idempotent
    expect(made.teardown).toHaveBeenCalledTimes(1);
  });

  it('BOUNDS the endChat teardown — a never-resolving (hung MCP) close still returns to Home', async () => {
    const made = makeSession({ stop: () => true }); // the first turn ends the session ⇒ endChat fires
    made.teardown.mockImplementation(() => new Promise<void>(() => undefined)); // a graceful close that never settles
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(() => Promise.resolve(made.session)),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
      boundTeardown: () => Promise.resolve(), // an instant bound (no real timer) — the deadline "wins" the race
    });

    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();

    expect(c.getSnapshot().mode).toBe('home'); // returned to Home despite the hung teardown — no freeze
    expect(c.getSnapshot().session).toBeUndefined();
  });

  it('teardownActive during a build-in-flight (a signal while loading) reaps the just-built session — no orphan', async () => {
    let resolveBuild: (s: HomeChatSession) => void = () => undefined;
    const made = makeSession();
    const startChat = vi.fn(() => new Promise<HomeChatSession>((r) => (resolveBuild = r)));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER); // → loading, build pending, NO session yet
    const teardown = c.teardownActive(); // the signal handler runs while still loading
    resolveBuild(made.session); // the build resolves into the terminating controller
    await teardown;

    // The in-flight build's session is reaped, not orphaned. (teardownActive AND submit's exiting-arm may each
    // reap it — both call the SAME idempotent real teardown, so the second is a benign no-op; only the fake counts
    // both. The guarantee that matters is "reaped ≥1 / no orphan", and that the chat was never mounted.)
    expect(made.teardown).toHaveBeenCalled();
    expect(c.getSnapshot().mode).not.toBe('chat'); // and never mounted
    expect(made.lines).toEqual([]);
  });

  it('/clear (stopReason clear) swaps in a FRESH session, staying in chat and tearing the old down (ADR-0062 §7)', async () => {
    // The first session's turn ends with stopReason 'clear' ⇒ clearChat builds a fresh session and STAYS in chat
    // (distinct from endChat, which returns to the bare Home). A build-first swap: the old is torn down only after
    // the fresh one is ready.
    const old = makeSession({ stop: () => true, stopReason: () => 'clear', sessionId: 'old-1' });
    const fresh = makeSession({ sessionId: 'fresh-2' });
    let built = 0;
    const startChat = vi.fn(() => Promise.resolve(built++ === 0 ? old.session : fresh.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER);
    // submit build → sendChatLine → processLine settle (stopReason 'clear') → clearChat build → swap; several
    // microtask/macrotask hops, so flush generously until the swap settles.
    for (let i = 0; i < 5; i++) await flush();

    expect(startChat).toHaveBeenCalledTimes(2); // the original session + the /clear rebuild
    expect(old.teardown).toHaveBeenCalledTimes(1); // the OLD session was torn down (its row marked 'ended')
    const snap = c.getSnapshot();
    expect(snap.mode).toBe('chat'); // STAYED in chat — no bare-Home flash (the /clear semantics)
    expect(snap.session).toBe(fresh.session); // the FRESH session is now live
    expect(snap.submitBusy).toBe(false); // the swap un-gated input
  });

  it('/clear keeps the OLD session live when the fresh build fails (build-first, no dead screen)', async () => {
    const old = makeSession({ stop: () => true, stopReason: () => 'clear', sessionId: 'old-1' });
    let built = 0;
    // First startChat builds the original; the /clear rebuild REJECTS (e.g. a transient provider fault).
    const startChat = vi.fn(() =>
      built++ === 0 ? Promise.resolve(old.session) : Promise.reject(new Error('no key')),
    );
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER);
    for (let i = 0; i < 5; i++) await flush();

    expect(startChat).toHaveBeenCalledTimes(2); // the rebuild was attempted
    expect(old.teardown).not.toHaveBeenCalled(); // the OLD session was KEPT (never torn down on a failed rebuild)
    const snap = c.getSnapshot();
    expect(snap.mode).toBe('chat'); // still in the old chat, not the bare Home
    expect(snap.session).toBe(old.session); // the old session stays live + resumable
    expect(snap.submitBusy).toBe(false); // input un-gated so the user can keep going or /exit
  });

  it('teardownActive during a /clear swap reaps BOTH the old session AND the in-flight fresh build (ADR-0062 §7)', async () => {
    // The widened teardownActive (no early return) must reap the "both live" window a /clear swap creates:
    // state.session === old AND buildInFlight === the fresh build. Hold the fresh build UNRESOLVED to sit in it.
    const old = makeSession({ stop: () => true, stopReason: () => 'clear', sessionId: 'old-1' });
    const fresh = makeSession({ sessionId: 'fresh-2' });
    let releaseFresh: (s: HomeChatSession) => void = () => undefined;
    let built = 0;
    const startChat = vi.fn(() =>
      built++ === 0
        ? Promise.resolve(old.session)
        : new Promise<HomeChatSession>((r) => (releaseFresh = r)),
    );
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER);
    for (let i = 0; i < 4; i++) await flush(); // submit → sendChatLine → /clear settle → clearChat starts the (held) fresh build
    expect(startChat).toHaveBeenCalledTimes(2); // both-live: old is state.session, the fresh build is in flight

    // A signal mid-swap: teardownActive must reap BOTH. It awaits the in-flight build, so resolve it during.
    const done = c.teardownActive();
    releaseFresh(fresh.session);
    await done;

    expect(old.teardown).toHaveBeenCalled(); // the OLD live session reaped
    expect(fresh.teardown).toHaveBeenCalled(); // AND the in-flight fresh build — neither MCP child orphaned
  });

  it('a signal during an in-flight endChat awaits the GRACEFUL teardown and skips the closed-db read', async () => {
    let releaseTeardown: () => void = () => undefined;
    const teardown = vi.fn(() => new Promise<void>((r) => (releaseTeardown = r))); // a slow (graceful MCP) close
    const session: HomeChatSession = {
      store: createChatStore(false),
      sessionId: 'sess-x',
      processLine: () => Promise.resolve(),
      shouldStop: () => true, // the first turn ends the session ⇒ endChat fires
      stopReason: () => 'exit', // /exit-style end → endChat (not the /clear swap)
      teardown,
    };
    const startChat = vi.fn(() => Promise.resolve(session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush(); // first turn settles ⇒ endChat starts the slow teardown (pending)
    const readsBefore = reads;

    const signal = c.teardownActive(); // tearingDown === session ⇒ it must AWAIT the in-flight teardown
    releaseTeardown(); // the graceful close completes
    await signal;

    expect(teardown).toHaveBeenCalledTimes(1); // a single graceful teardown, awaited by the signal path
    expect(reads).toBe(readsBefore); // endChat's deferred finally hit the `exiting` guard — no read on the closing db
  });

  it('ignores a keystroke that arrives while a chat session is tearing down (no sendMessage on a cancelled session)', async () => {
    let releaseTeardown: () => void = () => undefined;
    const lines: string[] = [];
    const session: HomeChatSession = {
      store: createChatStore(false),
      sessionId: 'sess-x',
      processLine: (line) => {
        lines.push(line);
        return Promise.resolve();
      },
      shouldStop: () => true,
      stopReason: () => 'exit',
      teardown: vi.fn(() => new Promise<void>((r) => (releaseTeardown = r))),
    };
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(() => Promise.resolve(session)),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush(); // endChat in flight (teardown pending), mode still 'chat', session still mounted
    lines.length = 0;

    c.handleKey('x', {}); // a key arriving mid-teardown
    c.handleKey('', ENTER); // a submit arriving mid-teardown
    expect(lines).toEqual([]); // the tearingDown guard ignored both — no line driven onto the cancelled session

    releaseTeardown();
    await flush();
  });

  it('does not re-settle driveHome after a turn error (the shared `exiting` guard)', async () => {
    const made = makeSession({ onProcess: () => Promise.reject(new Error('boom')) });
    const onExit = vi.fn();
    const onError = vi.fn();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(() => Promise.resolve(made.session)),
      homeStore,
      onExit,
      onError,
    });
    type(c, 'go');
    c.handleKey('', ENTER);
    await flush();
    expect(onError).toHaveBeenCalledTimes(1); // failHome fired once

    c.handleKey('c', CTRL_C); // a later Ctrl-C must NOT re-settle (exiting is already true)
    expect(onExit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('Ctrl-D (EOF) on an empty Home prompt exits; with text in the buffer it does not (no data loss)', () => {
    const onExit = vi.fn();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit,
      onError: vi.fn(),
    });
    type(c, 'draft');
    c.handleKey('d', { ctrl: true }); // Ctrl-D with a non-empty buffer → ignored
    expect(onExit).not.toHaveBeenCalled();
    expect(c.getSnapshot().input.text).toBe('draft'); // the buffer is preserved

    type(c, ''); // (no-op)
    c.handleKey('', { backspace: true });
    c.handleKey('', { backspace: true });
    c.handleKey('', { backspace: true });
    c.handleKey('', { backspace: true });
    c.handleKey('', { backspace: true }); // empty the buffer
    // Assert the WHOLE EditorState so repeated deleteBeforeCursor decrements the Home cursor back to 0 (not just
    // that .text emptied) — pins the primitive step 2's cursor motions build directly on top of.
    expect(c.getSnapshot().input).toEqual({ text: '', cursor: 0 });
    c.handleKey('d', { ctrl: true }); // Ctrl-D on the empty buffer → clean exit (EOF)
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  describe('bracketed paste (DECSET 2004)', () => {
    it('appends a multi-line paste literally (newlines kept) and does NOT submit early', () => {
      const startChat = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey('line1\nline2\r\nline3', {}); // ink delivers the bracketed content as one event (with a CRLF)
      c.handleKey(PASTE_END, {});
      // The whole EditorState: insertAtCursor advances the cursor past the multi-char pasted block (18 units).
      // The pasted CRLF is normalized to a single LF (no stray '\r' reaches the model/transcript), so the block
      // is 17 units, not 18 — matching the reduceEditorMotion append path.
      expect(c.getSnapshot().input).toEqual({ text: 'line1\nline2\nline3', cursor: 17 });
      expect(startChat).not.toHaveBeenCalled(); // nothing submitted by the embedded newlines
      expect(c.getSnapshot().mode).toBe('home');
    });

    it('the markers themselves never reach the buffer', () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey(PASTE_END, {});
      expect(c.getSnapshot().input.text).toBe('');
    });

    it('a literal Enter still submits once the paste has ended', async () => {
      const made = makeSession();
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey('deploy.yaml contents', {});
      c.handleKey(PASTE_END, {});
      c.handleKey('', ENTER); // a real key press AFTER the paste submits
      await flush();
      expect(startChat).toHaveBeenCalledTimes(1);
      expect(made.lines).toEqual(['deploy.yaml contents']);
    });

    it('reassembles a paste delivered across MULTIPLE chunks (none submits, order + newlines preserved)', () => {
      const startChat = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey('first\n', {}); // ink can split a large paste across stdin reads
      c.handleKey('\r', { return: true }); // even a lone CR chunk INSIDE the paste is literal, not a submit
      c.handleKey('second', {});
      c.handleKey(PASTE_END, {});
      // The cursor advances across EVERY chunk's insert (6 + 1 + 6 = 13 units), not just the first.
      // The lone CR chunk between the two lines normalizes to LF (never a stray '\r'); length is unchanged (13).
      expect(c.getSnapshot().input).toEqual({ text: 'first\n\nsecond', cursor: 13 });
      expect(startChat).not.toHaveBeenCalled();
    });

    it('Ctrl-C ALWAYS escapes a stuck paste (a lost end-marker must never trap the user) — Home exits', () => {
      const onExit = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit,
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey('half a paste', {}); // the [201~ end marker never arrives
      c.handleKey('c', CTRL_C); // the user bails out
      expect(onExit).toHaveBeenCalledTimes(1); // the latch is cleared and the Home exits cleanly
    });

    it('Ctrl-C escapes a stuck paste inside a chat as a /cancel (not swallowed)', async () => {
      const made = makeSession();
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hi');
      c.handleKey('', ENTER);
      await flush();
      made.lines.length = 0;

      c.handleKey(PASTE_START, {});
      c.handleKey('oops', {}); // end marker lost mid-chat
      c.handleKey('c', CTRL_C);
      expect(made.lines).toEqual(['/cancel']); // the chat cancels rather than wedging
    });

    it('drops paste content while a chat turn is running (matches the mid-turn keystroke gate)', async () => {
      const made = makeSession({ running: true });
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'go');
      c.handleKey('', ENTER);
      await flush(); // mode 'chat', the (stubbed) store reports running

      c.handleKey(PASTE_START, {});
      c.handleKey('type-ahead block', {});
      c.handleKey(PASTE_END, {});
      expect(c.getSnapshot().input.text).toBe(''); // dropped mid-turn, like every other key
    });

    it('drops paste content during the `loading` build window, matching the keystroke gate (no leak into the chat prompt)', async () => {
      const made = makeSession();
      let resolveBuild: (s: HomeChatSession) => void = () => undefined;
      const startChat = vi.fn(() => new Promise<HomeChatSession>((r) => (resolveBuild = r)));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hi');
      c.handleKey('', ENTER); // → loading, build pending
      expect(c.getSnapshot().mode).toBe('loading');

      c.handleKey(PASTE_START, {});
      c.handleKey('pasted-while-loading', {}); // a key typed here is dropped — so must a paste be
      c.handleKey(PASTE_END, {});

      resolveBuild(made.session);
      await flush();
      expect(c.getSnapshot().mode).toBe('chat');
      expect(c.getSnapshot().input.text).toBe(''); // the paste did NOT leak into the freshly-mounted chat prompt
    });

    it('drops EVERY chunk of a multi-chunk paste while a turn runs', async () => {
      const made = makeSession({ running: true });
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'go');
      c.handleKey('', ENTER);
      await flush(); // chat, running (stub)

      c.handleKey(PASTE_START, {});
      c.handleKey('chunk1\n', {});
      c.handleKey('chunk2', {});
      c.handleKey(PASTE_END, {});
      expect(c.getSnapshot().input.text).toBe(''); // all chunks dropped, not just the first
    });
  });

  describe('the / command palette (2.5.C S3b)', () => {
    const DOWN = { downArrow: true } as const;
    const ESC = { escape: true } as const;

    /** Build a controller, submit a first message so it is in `chat` mode at an empty prompt, ready for the palette. */
    const intoChat = async (
      made: ReturnType<typeof makeSession>,
    ): Promise<ReturnType<typeof createHomeController>> => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: () => Promise.resolve(made.session),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hi');
      c.handleKey('', ENTER);
      await flush();
      return c;
    };

    it('opens on a literal "/" at an empty chat prompt', async () => {
      const c = await intoChat(makeSession());
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toEqual({ query: '', index: 0 });
    });

    it('filters as you type and Enter submits the highlighted command as a slash line', async () => {
      const made = makeSession();
      const c = await intoChat(made);
      c.handleKey('/', {});
      type(c, 'ex'); // filter → [exit, export]
      c.handleKey('', DOWN); // highlight export
      expect(c.getSnapshot().palette).toEqual({ query: 'ex', index: 1 });
      c.handleKey('', ENTER); // select → submit /export through the chat dispatch
      await flush();
      expect(made.lines).toEqual(['hi', '/export']);
      expect(c.getSnapshot().palette).toBeUndefined(); // closed after running
    });

    it('Esc closes the palette without submitting anything', async () => {
      const made = makeSession();
      const c = await intoChat(made);
      c.handleKey('/', {});
      c.handleKey('', ESC);
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(made.lines).toEqual(['hi']); // nothing else submitted
    });

    it('Ctrl-C closes the palette (a gentle escape — it does not /cancel the chat)', async () => {
      const made = makeSession();
      const c = await intoChat(made);
      c.handleKey('/', {});
      c.handleKey('c', CTRL_C);
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(made.lines).toEqual(['hi']); // no /cancel leaked
    });

    it('a "/" mid-message is a normal character — the palette only triggers at an empty prompt', async () => {
      const c = await intoChat(makeSession());
      type(c, 'ab');
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('ab/');
    });

    it('does not open mid-turn — "/" while a turn streams is ignored, not a palette trigger', async () => {
      const c = await intoChat(makeSession({ running: true })); // the session store reports `running`
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toBeUndefined();
    });
  });

  describe('the / command palette in the bare Home (2.5.C S3c)', () => {
    const ESC = { escape: true } as const;

    it('opens on "/" at the Home prompt, and selecting /exit ends the Home', () => {
      const onExit = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit,
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toEqual({ query: '', index: 0 }); // HOME_PALETTE_COMMANDS = [exit, doctor]; index 0 = /exit
      c.handleKey('', ENTER); // select the highlighted /exit → run over the Home context → exitHome
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(c.getSnapshot().palette).toBeUndefined();
    });

    it('Esc closes the Home palette without exiting', () => {
      const onExit = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit,
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      c.handleKey('', ESC);
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(onExit).not.toHaveBeenCalled();
    });

    it('Ctrl-C closes the Home palette (the always-escapes hatch — does not exit the Home)', () => {
      const onExit = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit,
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      c.handleKey('c', CTRL_C);
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(onExit).not.toHaveBeenCalled();
    });

    it('a "/" mid-message in the Home is a normal character (the palette only triggers at an empty prompt)', () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'ab');
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('ab/');
    });

    it('does not open while a build is loading (the loading guard fires before the trigger)', () => {
      const startChat = vi.fn(() => new Promise<HomeChatSession>(() => undefined)); // never resolves
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hello');
      c.handleKey('', ENTER); // → loading (the build is in flight)
      expect(c.getSnapshot().mode).toBe('loading');
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toBeUndefined();
    });

    it('typing in the Home palette updates the query (the filter state path runs in the Home too)', () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'ex'); // 'ex' filters [exit, doctor] → [exit]; the query updates
      expect(c.getSnapshot().palette).toEqual({ query: 'ex', index: 0 });
    });

    it('selecting /doctor runs the fast tier into the Home notice surface', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc'); // filter [exit, doctor] → [doctor]
      c.handleKey('', ENTER); // select /doctor → runDoctor(false) over the Home context
      expect(c.getSnapshot().palette).toBeUndefined();
      await flush(); // the async runDoctor settles
      // Assert the rendered ROWS, not just the heading — so a malformed/missing check row would fail the test.
      const notice = c.getSnapshot().notice;
      expect(notice).toContain('doctor: all checks passed');
      expect(notice).toContain('✓ OS keychain: reachable');
      expect(notice).toContain('✓ config: valid');
      expect(notice).toContain('✓ wired tools: none'); // the STUB toolHost wires no arms
    });

    it('the Home /doctor notice clears on the next keystroke', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER);
      await flush();
      expect(c.getSnapshot().notice).toBeDefined();
      type(c, 'x'); // typing moves on — the report clears
      expect(c.getSnapshot().notice).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('x');
    });

    it('a NO-OP cursor motion does NOT clear the Home /doctor notice (only a real edit does)', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER);
      await flush();
      expect(c.getSnapshot().notice).toBeDefined();
      // The prompt is empty, so every cursor motion is a no-op (applyEditorAction returns the SAME reference); a
      // boundary motion must NOT clear the report the user is reading (the widened edit arm was clearing it).
      c.handleKey('', { leftArrow: true });
      c.handleKey('a', { ctrl: true }); // Ctrl+A (line-start) on an empty buffer
      c.handleKey('', { end: true });
      expect(c.getSnapshot().notice).toBeDefined(); // preserved
      expect(c.getSnapshot().input).toEqual({ text: '', cursor: 0 }); // untouched
    });

    it('a faulting fast-tier probe surfaces as a failed check (secret-free), never a crash', async () => {
      const probes = {
        ...STUB_DOCTOR_PROBES,
        keychain: () => {
          throw new Error('keychain locked');
        },
      };
      const c = createHomeController({
        doctorProbes: probes,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER);
      await flush();
      const notice = c.getSnapshot().notice;
      expect(notice).toContain('doctor: 1 check(s) failed');
      expect(notice).toContain('✗ OS keychain: keychain locked');
    });

    it('a report does NOT land if the prompt is edited during the run (the stale-run token guard)', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER); // run /doctor: sets 'checking…' synchronously, then awaits
      type(c, 'x'); // edit the prompt BEFORE the run settles — bumps the run token + clears the notice
      await flush(); // the run resolves; its report is dropped (token mismatch), not re-shown over what's typed
      expect(c.getSnapshot().notice).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('x');
    });

    it('a report does NOT land if the palette is re-opened during the run (the palette branch of the guard)', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER); // run /doctor (closes the palette, sets 'checking…'), then awaits
      c.handleKey('/', {}); // re-open the palette BEFORE the run settles (clears the notice; token is unchanged)
      await flush(); // the run resolves; the palette is open, so the report must NOT land over it
      expect(c.getSnapshot().palette).toBeDefined();
      expect(c.getSnapshot().notice).toBeUndefined();
    });

    it('a paste clears a stale /doctor notice (parity with typing)', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER);
      await flush();
      expect(c.getSnapshot().notice).toBeDefined();
      c.handleKey(PASTE_START, {});
      c.handleKey('pasted', {});
      c.handleKey(PASTE_END, {});
      expect(c.getSnapshot().notice).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('pasted');
    });
  });

  describe('in-chat mode / approval / abort keys (ADR-0057)', () => {
    const inChat = async (made: ReturnType<typeof makeSession>): Promise<HomeController> => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: () => Promise.resolve(made.session),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hi');
      c.handleKey('', ENTER);
      await flush(); // loading → chat, first line sent — now handleKey routes to handleChatKey
      return c;
    };
    const approvalReq = {
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: 'x' },
    } as const;

    it('Shift+Tab cycles the chat mode via onModeChange (ask → plan)', async () => {
      const onModeChange = vi.fn();
      const c = await inChat(makeSession({ onModeChange }));
      c.handleKey('', { tab: true, shift: true });
      expect(onModeChange).toHaveBeenCalledWith('plan'); // default ask → plan
    });

    it('Esc aborts the in-flight turn via onAbort (mid-turn; the session is not cancelled)', async () => {
      const onAbort = vi.fn();
      const made = makeSession({ onAbort, running: true });
      const c = await inChat(made);
      c.handleKey('', { escape: true });
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(made.lines).not.toContain('/cancel'); // abort ≠ /cancel — the session stays alive
    });

    it('Esc REJECTS a pending approval when onAbort is ABSENT — never a dead key / stuck prompt', async () => {
      // A session wired WITHOUT onAbort must still let Esc resolve a pending approval (reject) rather than leave
      // it hung — the home-controller abort fallback (a pending approval + no onAbort ⇒ answerApproval reject).
      const store = createChatStore(false);
      const c = await inChat(makeSession({ store })); // no onAbort
      const pending = store.requestApproval(approvalReq, true);
      c.handleKey('', { escape: true });
      await expect(pending).resolves.toEqual({ outcome: 'reject' });
    });

    it('Esc with onAbort PRESENT aborts the turn and does NOT also answer the approval (no double-settle)', async () => {
      // The `if onAbort` branch wins: the turn is aborted (its signal resolves the approval); the fallback
      // answerApproval must NOT also fire (a refactor to two independent `if`s would double-settle).
      const onAbort = vi.fn();
      const store = createChatStore(false);
      const c = await inChat(makeSession({ onAbort, store }));
      const pending = store.requestApproval(approvalReq, true);
      void pending.catch(() => undefined); // onAbort is a mock (doesn't fire the signal) — avoid an unhandled reject
      c.handleKey('', { escape: true });
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().approval).not.toBeUndefined(); // the fallback did NOT answer it — onAbort owns the abort
    });

    it('a pending approval intercepts keys: `/` stays closed and `[y]` approves-once', async () => {
      const store = createChatStore(false);
      const c = await inChat(makeSession({ store }));
      const pending = store.requestApproval(approvalReq, true);
      c.handleKey('/', {}); // the approval owns the keyboard — the palette must NOT open
      expect(c.getSnapshot().palette).toBeUndefined();
      c.handleKey('y', {});
      await expect(pending).resolves.toEqual({ outcome: 'approve', scope: 'once' });
    });

    it('a pending approval: `[a]` approves-always, `[n]` rejects', async () => {
      const alwaysStore = createChatStore(false);
      const ca = await inChat(makeSession({ store: alwaysStore }));
      const alwaysPending = alwaysStore.requestApproval(approvalReq, true);
      ca.handleKey('a', {});
      await expect(alwaysPending).resolves.toEqual({ outcome: 'approve', scope: 'always' });

      const rejectStore = createChatStore(false);
      const cr = await inChat(makeSession({ store: rejectStore }));
      const rejectPending = rejectStore.requestApproval(approvalReq, true);
      cr.handleKey('n', {});
      await expect(rejectPending).resolves.toEqual({ outcome: 'reject' });
    });
  });
});
