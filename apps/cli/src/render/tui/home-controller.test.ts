import type { TranscriptEntry } from './session-view-model.js';
import type { ReseatTarget } from '../../commands/chat.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChatMode } from '../../chat/chat-mode.js';
import type { DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeModelsPort,
} from './home-controller.js';
import type { UserCommandOutcome } from '@relavium/core';
import type { ModelCatalogEntry } from '@relavium/llm';
import { REASONING_EFFORTS, type ReasoningEffort } from '@relavium/shared';

import type { RefreshReport } from '../../engine/model-refresh.js';

import type { MentionReader } from './mention.js';

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
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
    onSetEffort?: (effort: ReasoningEffort) => void;
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
  const store =
    opts.store ??
    (opts.running === true
      ? runningStore()
      : createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND));
  const session: HomeChatSession = {
    store,
    sessionId: opts.sessionId ?? 'sess-fake',
    processLine: async (line) => {
      lines.push(line);
      if (opts.onProcess) await opts.onProcess();
    },
    shouldStop: opts.stop ?? (() => false),
    stopReason: opts.stopReason ?? (() => 'exit'),
    ...(opts.onSetEffort === undefined ? {} : { onSetEffort: opts.onSetEffort }),
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

  it('in-Home chat: a PASTE resets history nav so a following Down does not clobber it', async () => {
    // A paste mutates the buffer exactly like a typed edit, so it must end history navigation — otherwise a stale
    // navIndex lets the next Down restore the pre-Up draft over the pasted text.
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
    await flush();

    c.handleKey('', { upArrow: true }); // Up-recall makes history navigation active (navIndex set)
    expect(c.getSnapshot().input.text).toBe('beta');
    c.handlePaste('!'); // a real edit ⇒ must reset history nav
    expect(c.getSnapshot().input.text).toBe('beta!');
    // Down is now a no-op (nav reset by the paste), NOT a historyNext that clobbers the pasted buffer.
    c.handleKey('', { downArrow: true });
    expect(c.getSnapshot().input.text).toBe('beta!');
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

  it('[c] typed-reason capture: opens on a pending approval, records the reason, rejects WITH it (Step 14)', async () => {
    const made = makeSession();
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
    expect(c.getSnapshot().mode).toBe('chat');

    // Inject a pending per-tool approval (a governed write) into the live session store.
    const request = {
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: 'notes.md' },
    } as const;
    const pending = made.store.requestApproval(request, true);

    // `[c]` opens the typed-reason capture (an empty buffer) — the [y]/[a]/[n] prompt is replaced.
    c.handleKey('c', {});
    expect(c.getSnapshot().reasonDraft).toEqual({ text: '', cursor: 0 });

    // Type a reason: a char that would OTHERWISE be an approval answer ('n'/'y') is now ordinary buffer text.
    type(c, 'use the project config instead');
    expect(c.getSnapshot().reasonDraft?.text).toBe('use the project config instead');

    // Enter submits the reject WITH the sanitized reason; the capture closes.
    c.handleKey('', ENTER);
    expect(c.getSnapshot().reasonDraft).toBeUndefined();
    await expect(pending).resolves.toEqual({
      outcome: 'reject',
      reason: 'use the project config instead',
    });
  });

  it('[c] then Esc cancels the reason capture — the approval stays pending, a later [n] plain-rejects (Step 14)', async () => {
    const made = makeSession();
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
    const request = {
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: 'notes.md' },
    } as const;
    const pending = made.store.requestApproval(request, true);

    c.handleKey('c', {}); // open the capture
    expect(c.getSnapshot().reasonDraft).toBeDefined();
    c.handleKey('', { escape: true }); // Esc CANCELS the reason (not an abort) — back to the choices
    expect(c.getSnapshot().reasonDraft).toBeUndefined();
    expect(made.store.getSnapshot().approval).toBeDefined(); // the approval is STILL pending

    c.handleKey('n', {}); // a plain reject (no reason) now settles it
    await expect(pending).resolves.toEqual({ outcome: 'reject' });
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
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
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
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
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

  describe('bracketed paste (native ink 7 usePaste → handlePaste)', () => {
    // ink 7 delivers a whole bracketed paste as ONE native event on the usePaste channel (markers stripped, chunks
    // reassembled by ink), routed to `handlePaste`. So a paste never arrives char-by-char, its embedded newlines
    // never submit, and its content never masquerades as a key answer to the fail-closed approval floor.
    it('appends a whole multi-line paste (CRLF/CR → LF) and does NOT submit', () => {
      const startChat = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handlePaste('line1\nline2\r\nline3'); // one native event; the CRLF normalizes to a single LF (17 units)
      expect(c.getSnapshot().input).toEqual({ text: 'line1\nline2\nline3', cursor: 17 });
      expect(startChat).not.toHaveBeenCalled(); // an embedded newline in a paste never submits
      expect(c.getSnapshot().mode).toBe('home');
    });

    it('a real Enter still submits after a paste', async () => {
      const made = makeSession();
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handlePaste('deploy.yaml contents');
      c.handleKey('', ENTER); // a real key press AFTER the paste submits
      await flush();
      expect(startChat).toHaveBeenCalledTimes(1);
      expect(made.lines).toEqual(['deploy.yaml contents']);
    });

    it('drops a paste while a chat turn is running (matches the mid-turn keystroke gate)', async () => {
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
      c.handlePaste('type-ahead block');
      expect(c.getSnapshot().input.text).toBe(''); // dropped mid-turn, like every other key
    });

    it('drops a paste during the `loading` build window (no leak into the freshly-mounted chat prompt)', async () => {
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
      const before = c.getSnapshot().input.text;
      c.handlePaste('pasted-while-loading'); // a key typed here is dropped — so must a paste be
      expect(c.getSnapshot().input.text).toBe(before);
      resolveBuild(made.session);
      await flush();
      expect(c.getSnapshot().mode).toBe('chat');
      expect(c.getSnapshot().input.text).toBe(''); // the paste did NOT leak into the freshly-mounted chat prompt
    });

    it('drops a paste while the `/` palette owns the keyboard (never leaks behind the overlay)', () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {}); // open the Home palette at the empty prompt
      expect(c.getSnapshot().palette).toBeDefined();
      c.handlePaste('behind the palette');
      expect(c.getSnapshot().input.text).toBe(''); // dropped — the palette owns the keyboard
    });

    it('SECURITY: a pasted approval token during a pending approval NEVER answers the fail-closed floor (ADR-0057)', async () => {
      const made = makeSession();
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
      const pending = made.store.requestApproval(
        { toolId: 'write_file', action: 'fs_write', preview: { path: 'notes.md' } } as const,
        true,
      );
      // A paste whose CONTENT is exactly the most-permissive approval token must be DROPPED — on ink 7 a paste is a
      // usePaste event, so it can never be routed to reduceApprovalKey and can never grant an auto-approve.
      c.handlePaste('a'); // 'a' = approve-always as a KEY; as a paste it must do nothing
      await flush();
      expect(made.store.getSnapshot().approval).toBeDefined(); // STILL pending — the paste did not answer it
      expect(c.getSnapshot().input.text).toBe(''); // nor did it leak into the hidden prompt buffer
      c.handleKey('n', {}); // a real [n] key rejects, so the pending promise settles (no dangling handle)
      await expect(pending).resolves.toEqual({ outcome: 'reject' });
    });

    it('drops a paste while the `[c]` reason capture owns the keyboard', async () => {
      const made = makeSession();
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
      const pending = made.store.requestApproval(
        { toolId: 'write_file', action: 'fs_write', preview: { path: 'notes.md' } } as const,
        true,
      );
      c.handleKey('c', {}); // open the reason capture
      expect(c.getSnapshot().reasonDraft).toEqual({ text: '', cursor: 0 });
      c.handlePaste('pasted reason?');
      expect(c.getSnapshot().reasonDraft?.text).toBe(''); // paste does not fill the reason buffer (dropped)
      expect(c.getSnapshot().input.text).toBe(''); // nor the main prompt
      c.handleKey('', { escape: true }); // cancel the capture
      c.handleKey('n', {}); // reject so the pending promise settles
      await expect(pending).resolves.toEqual({ outcome: 'reject' });
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
      c.handlePaste('pasted');
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

    it('Ctrl+T toggles the reasoning panel via the store (2.5.H — parity with relavium chat)', async () => {
      const made = makeSession({});
      const c = await inChat(made);
      expect(made.store.getSnapshot().reasoningVisible).toBe(false); // collapsed by default
      c.handleKey('t', { ctrl: true });
      expect(made.store.getSnapshot().reasoningVisible).toBe(true);
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
      const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
      const c = await inChat(makeSession({ store })); // no onAbort
      const pending = store.requestApproval(approvalReq, true);
      c.handleKey('', { escape: true });
      await expect(pending).resolves.toEqual({ outcome: 'reject' });
    });

    it('Esc with onAbort PRESENT aborts the turn and does NOT also answer the approval (no double-settle)', async () => {
      // The `if onAbort` branch wins: the turn is aborted (its signal resolves the approval); the fallback
      // answerApproval must NOT also fire (a refactor to two independent `if`s would double-settle).
      const onAbort = vi.fn();
      const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
      const c = await inChat(makeSession({ onAbort, store }));
      const pending = store.requestApproval(approvalReq, true);
      void pending.catch(() => undefined); // onAbort is a mock (doesn't fire the signal) — avoid an unhandled reject
      c.handleKey('', { escape: true });
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().approval).not.toBeUndefined(); // the fallback did NOT answer it — onAbort owns the abort
    });

    it('a pending approval intercepts keys: `/` stays closed and `[y]` approves-once', async () => {
      const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
      const c = await inChat(makeSession({ store }));
      const pending = store.requestApproval(approvalReq, true);
      c.handleKey('/', {}); // the approval owns the keyboard — the palette must NOT open
      expect(c.getSnapshot().palette).toBeUndefined();
      c.handleKey('y', {});
      await expect(pending).resolves.toEqual({ outcome: 'approve', scope: 'once' });
    });

    it('a pending approval: `[a]` approves-always, `[n]` rejects', async () => {
      const alwaysStore = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
      const ca = await inChat(makeSession({ store: alwaysStore }));
      const alwaysPending = alwaysStore.requestApproval(approvalReq, true);
      ca.handleKey('a', {});
      await expect(alwaysPending).resolves.toEqual({ outcome: 'approve', scope: 'always' });

      const rejectStore = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
      const cr = await inChat(makeSession({ store: rejectStore }));
      const rejectPending = rejectStore.requestApproval(approvalReq, true);
      cr.handleKey('n', {});
      await expect(rejectPending).resolves.toEqual({ outcome: 'reject' });
    });
  });
});

/* ------------------------------------------------------------------------------------------------ *
 * The `/models` picker (2.5.G S7 / ADR-0064 §10) — HOME-ONLY, opened via the Home `/` palette.
 * ------------------------------------------------------------------------------------------------ */

const CTRL_R = { ctrl: true } as const;

/** A merged catalog entry with sensible defaults for the picker port fake. */
function pickerEntry(
  partial: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, 'modelId'>,
): ModelCatalogEntry {
  return {
    provider: 'anthropic',
    displayName: partial.modelId,
    pricingSource: 'registry',
    priceKnown: true,
    available: true,
    deprecated: false,
    ...partial,
  };
}

/**
 * A controllable {@link HomeModelsPort} fake. `writeDefault` records the written id, and `currentDefault` returns
 * it (so `accept` reports success) UNLESS `overrideDefault` is set — which simulates a project/workspace
 * `[chat].default_model` shadowing the global write (the effective default stays the override). `writeThrows`
 * simulates a config-write fault.
 */
function makeModelsPort(
  opts: {
    entries?: readonly ModelCatalogEntry[];
    refreshedAt?: number;
    overrideDefault?: string;
    currentEffort?: ReasoningEffort; // the effective effort default (the bare-Home effort sub-list's ✓/highlight)
    writeThrows?: boolean;
    readFaults?: boolean; // currentDefault always returns undefined (a config re-read fault after a good write)
    loadThrows?: boolean; // load() throws (a DB read fault)
    refreshIfStale?: () => Promise<Awaited<ReturnType<HomeModelsPort['refreshIfStale']>>>;
    refresh?: () => Promise<Awaited<ReturnType<HomeModelsPort['refresh']>>>;
  } = {},
): {
  port: HomeModelsPort;
  load: ReturnType<typeof vi.fn>;
  refreshIfStale: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  writeDefault: ReturnType<typeof vi.fn>;
} {
  const entries = opts.entries ?? [pickerEntry({ modelId: 'a' }), pickerEntry({ modelId: 'b' })];
  let written: string | undefined;
  let writtenEffort: ReasoningEffort | undefined;
  const load = vi.fn(() => {
    if (opts.loadThrows === true) throw new Error('catalog read failed');
    return { entries, refreshedAt: opts.refreshedAt };
  });
  const refreshIfStale = vi.fn(opts.refreshIfStale ?? (() => Promise.resolve(undefined)));
  const refresh = vi.fn(opts.refresh ?? (() => Promise.resolve({ providers: [] })));
  const writeDefault = vi.fn((modelId: string, reasoningEffort?: ReasoningEffort) => {
    if (opts.writeThrows === true) throw new Error('config write failed');
    written = modelId;
    if (reasoningEffort !== undefined) writtenEffort = reasoningEffort;
  });
  const port: HomeModelsPort = {
    load,
    refreshIfStale,
    refresh,
    // The EFFECTIVE default: a read fault ⇒ undefined; else the override wins (shadows the global write), else the
    // last written id.
    currentDefault: () =>
      opts.readFaults === true ? undefined : (opts.overrideDefault ?? written),
    // The EFFECTIVE effort default: an explicit `currentEffort` opt wins (a pre-existing config default), else the
    // last written effort (so a re-opened picker shows the ✓ on it).
    currentEffort: () => opts.currentEffort ?? writtenEffort,
    writeDefault,
  };
  return { port, load, refreshIfStale, refresh, writeDefault };
}

describe('the /models picker in the bare Home (2.5.G S7 / ADR-0064 §10)', () => {
  const EMPTY_HOME: HomeSnapshot = {
    attention: { gates: [], failedRuns: [] },
    recentSessions: [],
    recentRuns: [],
    recentAgents: [],
    isEmpty: true,
  };
  const homeStore: HomeStore = { read: () => EMPTY_HOME };

  /** Build a Home controller with the given models port, then open the picker via the `/` palette (the real path). */
  function openPicker(port: HomeModelsPort): HomeController {
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
      models: port,
    });
    c.handleKey('/', {}); // open the palette
    type(c, 'models'); // filter HOME_PALETTE_COMMANDS → [/models]
    c.handleKey('', ENTER); // run the highlighted /models → homeReplCtx.openModels → the picker opens
    return c;
  }

  it('opens over the merged catalog and kicks a TTL-bounded background refresh', async () => {
    const { port, load, refreshIfStale } = makeModelsPort({ refreshedAt: 1000 });
    const c = openPicker(port);
    const picker = c.getSnapshot().modelPicker;
    expect(picker?.entries.map((e) => e.modelId)).toEqual(['a', 'b']);
    expect(picker?.refreshedAt).toBe(1000);
    expect(refreshIfStale).toHaveBeenCalledTimes(1); // the auto background refresh (ADR-0064 §5c)
    await flush();
    // Nothing was stale (refreshIfStale → undefined): the spinner clears, the cache stands.
    expect(c.getSnapshot().modelPicker?.loading).toBe(false);
    expect(load).toHaveBeenCalled();
  });

  it('selecting a model writes the NEXT session default, closes the picker, and confirms in the notice', async () => {
    const { port, writeDefault } = makeModelsPort({
      entries: [pickerEntry({ modelId: 'claude-x', displayName: 'Claude X' })],
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('', ENTER); // accept the selected (available) model
    expect(writeDefault).toHaveBeenCalledWith('claude-x', undefined); // non-reasoning ⇒ model only, no effort
    expect(c.getSnapshot().modelPicker).toBeUndefined(); // the picker closed
    expect(c.getSnapshot().notice).toContain('Claude X'); // the confirmation names the model
    expect(c.getSnapshot().notice).toContain('next chat session'); // it is a NEXT-session action, not a live reseat
  });

  it('bare Home: a REASONING model offers the effort sub-step, writing BOTH model + effort defaults (ADR-0066 §6)', async () => {
    // ADR-0066 §6: in the bare Home a reasoning model advances to the effort sub-step (opened on the config effort
    // default), and accepting writes model + effort together — so the user sets both future-session defaults at once.
    const { port, writeDefault } = makeModelsPort({
      entries: [
        pickerEntry({
          modelId: 'deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
        }),
      ],
      currentEffort: 'low', // the existing effort default — the sub-list opens highlighted on it
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('', ENTER); // model phase: Enter on the reasoning model ⇒ advance to the effort sub-step
    expect(c.getSnapshot().modelPicker?.phase).toBe('effort');
    expect(c.getSnapshot().modelPicker?.currentEffort).toBe('low'); // opened on the config effort default
    c.handleKey('', { downArrow: true }); // low → medium
    c.handleKey('', { downArrow: true }); // medium → high
    c.handleKey('', ENTER); // accept the model + 'high'

    expect(writeDefault).toHaveBeenCalledWith('deepseek-v4-flash', 'high'); // BOTH written (one atomic call)
    expect(c.getSnapshot().modelPicker).toBeUndefined(); // closed
    expect(c.getSnapshot().notice).toContain('DeepSeek V4 Flash');
    expect(c.getSnapshot().notice).toContain('effort high'); // the notice names the written effort
    expect(c.getSnapshot().notice).toContain('next chat session');
  });

  it('bare Home: a reasoning model with NO prior effort default opens on medium; immediate Enter writes medium (ADR-0066 §6)', async () => {
    // No `currentEffort` opt ⇒ the sub-list opens on the neutral 'medium' (initialEffortIndex(undefined)). There is
    // no "model-only, skip effort" path for a reasoning model in the bare Home (Esc only backs to the model list), so
    // accepting immediately writes the neutral default — pin that intended behavior (ADR-0066 §6).
    const { port, writeDefault } = makeModelsPort({
      entries: [
        pickerEntry({
          modelId: 'deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
        }),
      ],
      // no currentEffort → port.currentEffort() is undefined
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('', ENTER); // advance to the effort sub-step
    expect(c.getSnapshot().modelPicker?.phase).toBe('effort');
    expect(c.getSnapshot().modelPicker?.currentEffort).toBeUndefined(); // no config effort default
    c.handleKey('', ENTER); // immediate Enter on the opening highlight (the neutral 'medium')

    expect(writeDefault).toHaveBeenCalledWith('deepseek-v4-flash', 'medium'); // the neutral default is written
    expect(c.getSnapshot().notice).toContain('effort medium');
  });

  it('an honest notice when a project/workspace setting overrides the global write (no false success)', async () => {
    // The write lands on the global file, but the effective default stays the project/workspace override, so the
    // notice must NOT claim "applies to your next chat session" — it says the override still wins here.
    const { port, writeDefault } = makeModelsPort({
      entries: [pickerEntry({ modelId: 'claude-x', displayName: 'Claude X' })],
      overrideDefault: 'project-pinned',
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('', ENTER);
    expect(writeDefault).toHaveBeenCalledWith('claude-x', undefined); // non-reasoning ⇒ model only, no effort
    expect(c.getSnapshot().notice).toContain('overrides it here');
    expect(c.getSnapshot().notice).not.toContain('next chat session'); // no false claim of effect
  });

  it('reports a DISTINCT notice when the config can\'t be re-read after a write (not "overrides")', async () => {
    const { port } = makeModelsPort({
      entries: [pickerEntry({ modelId: 'claude-x', displayName: 'Claude X' })],
      readFaults: true, // the write succeeds, but the re-read to confirm the effective default throws → undefined
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('', ENTER);
    expect(c.getSnapshot().notice).toContain('could not be re-read');
    expect(c.getSnapshot().notice).not.toContain('overrides'); // a read fault is NOT an override
    expect(c.getSnapshot().notice).not.toContain('next chat session'); // nor a confirmed success
  });

  it('a catalog read fault on OPEN degrades to a notice, never crashes the Home (never opens a broken picker)', () => {
    const { port } = makeModelsPort({ loadThrows: true });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
      models: port,
    });
    c.handleKey('/', {});
    type(c, 'models');
    c.handleKey('', ENTER); // /models → openModelPicker → port.load() throws → caught
    expect(c.getSnapshot().modelPicker).toBeUndefined(); // no half-open picker
    expect(c.getSnapshot().notice).toContain('could not read the model catalog');
  });

  it('a write fault keeps the picker OPEN with a secret-free hint, never crashes the Home', async () => {
    const { port } = makeModelsPort({
      entries: [pickerEntry({ modelId: 'claude-x', displayName: 'Claude X' })],
      writeThrows: true,
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('', ENTER);
    expect(c.getSnapshot().modelPicker).toBeDefined(); // stays open (recoverable)
    expect(c.getSnapshot().modelPicker?.hint).toContain('could not save');
    expect(c.getSnapshot().notice).toBeUndefined(); // no success notice on a failed write
  });

  it('a DIMMED (unavailable) model is non-selectable: Enter shows a HINT, never a write', async () => {
    const { port, writeDefault } = makeModelsPort({
      entries: [pickerEntry({ modelId: 'gone', displayName: 'Gone', available: false })],
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('', ENTER);
    expect(writeDefault).not.toHaveBeenCalled(); // never write an unusable default
    expect(c.getSnapshot().modelPicker).toBeDefined(); // stays open
    expect(c.getSnapshot().modelPicker?.hint).toContain('Gone'); // an actionable action-hint (not the refresh banner)
    // A navigation keystroke clears the transient hint (the user has moved on).
    c.handleKey('x', {}); // a filter keystroke → 'state' step → hint cleared
    expect(c.getSnapshot().modelPicker?.hint).toBeUndefined();
  });

  it('a `no-key` model is non-selectable with a hint NAMING the remedy (provider add) (2.5.G)', async () => {
    const { port, writeDefault } = makeModelsPort({
      entries: [
        pickerEntry({
          modelId: 'x',
          displayName: 'Model X',
          provider: 'openai',
          available: false,
          unavailableReason: 'no-key',
        }),
      ],
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('', ENTER);
    expect(writeDefault).not.toHaveBeenCalled(); // a keyless model can never become the default
    const hint = c.getSnapshot().modelPicker?.hint ?? '';
    expect(hint).toContain('openai'); // names the provider
    expect(hint).toContain('provider set-key'); // and the actionable single-command remedy
  });

  it('Esc closes the picker without writing a default', async () => {
    const { port, writeDefault } = makeModelsPort();
    const c = openPicker(port);
    await flush();
    c.handleKey('', { escape: true });
    expect(c.getSnapshot().modelPicker).toBeUndefined();
    expect(writeDefault).not.toHaveBeenCalled();
  });

  it('Ctrl+R runs an unbounded refresh; a per-provider failure surfaces a secret-free banner', async () => {
    const { port, refresh } = makeModelsPort({
      refresh: () =>
        Promise.resolve({
          providers: [{ provider: 'openai', status: 'failed', error: 'redacted' }],
        }),
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('r', CTRL_R);
    expect(refresh).toHaveBeenCalledTimes(1);
    await flush();
    const picker = c.getSnapshot().modelPicker;
    expect(picker?.loading).toBe(false);
    expect(picker?.banner).toContain('openai'); // names the failed provider, not the (redacted) error body
    expect(picker?.banner).not.toContain('redacted');
  });

  it("a reopened picker is NOT clobbered by a prior open's slow refresh (the epoch guard)", async () => {
    // Open #1 kicks a SLOW refreshIfStale; open #2 (after a close) gets a fast one. When the slow first refresh
    // finally resolves with a partial failure, it must NOT stamp the SECOND picker's banner (a different generation).
    let resolveSlow: (report: RefreshReport) => void = () => undefined;
    let call = 0;
    const { port } = makeModelsPort({
      refreshIfStale: () => {
        call += 1;
        return call === 1
          ? new Promise<RefreshReport>((res) => {
              resolveSlow = res;
            })
          : Promise.resolve(undefined);
      },
    });
    const c = openPicker(port); // open #1 → the slow refresh is in flight (generation 1)
    c.handleKey('', { escape: true }); // close it
    // Reopen on the SAME controller (open #2, generation 2) via the palette.
    c.handleKey('/', {});
    type(c, 'models');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().modelPicker).toBeDefined(); // picker #2 is open

    resolveSlow({ providers: [{ provider: 'openai', status: 'failed', error: 'redacted' }] }); // gen-1 refresh lands late
    await flush();
    // The stale gen-1 result is dropped — picker #2's banner is untouched (no ghost partial-failure).
    expect(c.getSnapshot().modelPicker?.banner).toBeUndefined();
  });

  it('the picker owns the keyboard: typing filters, it does not edit the Home buffer', async () => {
    const { port } = makeModelsPort({
      entries: [pickerEntry({ modelId: 'alpha' }), pickerEntry({ modelId: 'beta' })],
    });
    const c = openPicker(port);
    await flush();
    c.handleKey('b', {}); // a printable char → extends the picker filter, NOT the Home prompt
    expect(c.getSnapshot().modelPicker?.filter).toBe('b');
    expect(c.getSnapshot().input.text).toBe(''); // the Home buffer behind the overlay is untouched
  });

  it('degrades to an honest notice when no models port is wired (a test/partial host)', () => {
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
      // no `models` port
    });
    c.handleKey('/', {});
    type(c, 'models');
    c.handleKey('', ENTER);
    expect(c.getSnapshot().modelPicker).toBeUndefined();
    expect(c.getSnapshot().notice).toContain('unavailable');
  });

  it('in-Home chat: /models opens the reseat picker; accepting a model RESEATS the live session (ADR-0059)', async () => {
    const sessionA = makeSession({ sessionId: 'sess-A' });
    // A LIVE chat has turns on screen — that is the conversation the reseat must carry (2.6.C / F1). An empty store
    // here would make the carry assertion below vacuous.
    sessionA.session.store.appendUser('what is 2+2');
    sessionA.session.store.notice('assistant: four');
    const sessionB = makeSession({ sessionId: 'sess-A' }); // a reseat continues the SAME sessionId
    const startChat = vi.fn(() => Promise.resolve(sessionA.session));
    const reseatChat = vi.fn<
      (id: string, t: ReseatTarget, carried: readonly TranscriptEntry[]) => Promise<HomeChatSession>
    >(() => Promise.resolve(sessionB.session));
    const { port } = makeModelsPort({
      entries: [pickerEntry({ modelId: 'claude-opus-4-8', provider: 'anthropic' })],
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      reseatChat,
      models: port,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER); // start the chat (session A)
    await flush();
    expect(c.getSnapshot().mode).toBe('chat');

    // Open the reseat picker from the chat palette (`/` → filter `models` → run) — the in-chat intercept opens the
    // picker instead of dispatching `/models` to the "interactive terminal" hint.
    c.handleKey('/', {});
    type(c, 'models');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().modelPicker).toBeDefined(); // the picker opened IN the chat

    // Accept the (only, available) model → a LIVE reseat, not a next-session-default write.
    c.handleKey('', ENTER);
    await flush();

    // The reseat is handed the OUTGOING store's rendered transcript (2.6.C / F1) — the conversation the reseated
    // store must open with, so the alt-screen viewport does not go blank. Passing `[]` here IS the bug.
    expect(reseatChat).toHaveBeenCalledWith(
      'sess-A',
      { modelId: 'claude-opus-4-8', provider: 'anthropic' },
      sessionA.session.store.getSnapshot().state.transcript,
    );
    expect(reseatChat.mock.calls[0]?.[2]).not.toHaveLength(0); // a live chat has turns; an empty carry is F1
    expect(sessionA.teardown).toHaveBeenCalledTimes(1); // the old session torn down (bounded)
    expect(c.getSnapshot().session).toBe(sessionB.session); // swapped to the reseated session
    expect(c.getSnapshot().mode).toBe('chat'); // stayed in chat (the model switched underneath)
    expect(c.getSnapshot().modelPicker).toBeUndefined(); // the picker closed
  });

  it('in-Home chat: a SAME-model effort change calls the setter — NO reseat (ADR-0066 §5)', async () => {
    // Bound to a reasoning-capable model at effort 'low'. Re-picking the SAME model then choosing 'high' in the
    // effort sub-step must push the SESSION override (onSetEffort) — NOT a reseat (which would tear the session down).
    const boundStore = createChatStore(
      false,
      { model: 'claude-opus-4-8', transcript: [] },
      INLINE_TRANSCRIPT_BOUND,
    );
    boundStore.setReasoningEffort('low'); // the session's current tier (drives the sub-list's ✓/highlight)
    const onSetEffort = vi.fn();
    const sessionA = makeSession({ sessionId: 'sess-A', store: boundStore, onSetEffort });
    const reseatChat = vi.fn(() => Promise.resolve(makeSession().session));
    const { port } = makeModelsPort({
      entries: [
        pickerEntry({ modelId: 'claude-opus-4-8', provider: 'anthropic' }),
      ],
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(sessionA.session),
      reseatChat,
      models: port,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    c.handleKey('/', {});
    type(c, 'models');
    c.handleKey('', ENTER);
    await flush();
    c.handleKey('', ENTER); // model phase: Enter on the reasoning model ⇒ advance to the effort sub-step
    expect(c.getSnapshot().modelPicker?.phase).toBe('effort');
    c.handleKey('', { downArrow: true }); // low → medium
    c.handleKey('', { downArrow: true }); // medium → high
    c.handleKey('', ENTER); // apply 'high'
    await flush();

    expect(onSetEffort).toHaveBeenCalledWith('high'); // the SESSION override (no reseat)
    expect(reseatChat).not.toHaveBeenCalled(); // an effort change is NOT a reseat (ADR-0066 §5, not option (d))
    expect(sessionA.teardown).not.toHaveBeenCalled(); // the live session is untouched (no teardown/MCP reconnect)
    expect(c.getSnapshot().modelPicker).toBeUndefined(); // the picker closed after the effort pick
  });

  it('in-Home chat: re-picking the SAME model AND same effort is a no-op (no setter, no reseat) (ADR-0066)', async () => {
    const boundStore = createChatStore(
      false,
      { model: 'claude-opus-4-8', transcript: [] },
      INLINE_TRANSCRIPT_BOUND,
    );
    boundStore.setReasoningEffort('high');
    const onSetEffort = vi.fn();
    const sessionA = makeSession({ sessionId: 'sess-A', store: boundStore, onSetEffort });
    const reseatChat = vi.fn(() => Promise.resolve(makeSession().session));
    const { port } = makeModelsPort({
      entries: [
        pickerEntry({ modelId: 'claude-opus-4-8', provider: 'anthropic' }),
      ],
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(sessionA.session),
      reseatChat,
      models: port,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    c.handleKey('/', {});
    type(c, 'models');
    c.handleKey('', ENTER);
    await flush();
    c.handleKey('', ENTER); // effort sub-step opens highlighted on the bound 'high'
    c.handleKey('', ENTER); // accept 'high' (unchanged)
    await flush();

    expect(onSetEffort).not.toHaveBeenCalled(); // same tier ⇒ no setter call
    expect(reseatChat).not.toHaveBeenCalled();
    expect(c.getSnapshot().modelPicker).toBeUndefined();
  });

  it('in-Home chat: accepting the ALREADY-bound model does NOT reseat — a no-op hint (ADR-0059)', async () => {
    // The session is bound to claude-opus-4-8; the only picker entry IS that model. Accepting it must NOT tear the
    // session down + rebuild for zero change (which would wipe the approval cache) — it keeps the picker open + hints.
    const boundStore = createChatStore(
      false,
      { model: 'claude-opus-4-8', transcript: [] },
      INLINE_TRANSCRIPT_BOUND,
    );
    const sessionA = makeSession({ sessionId: 'sess-A', store: boundStore });
    const reseatChat = vi.fn(() => Promise.resolve(makeSession().session));
    const { port } = makeModelsPort({
      entries: [pickerEntry({ modelId: 'claude-opus-4-8', provider: 'anthropic' })],
    });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(sessionA.session),
      reseatChat,
      models: port,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    c.handleKey('/', {});
    type(c, 'models');
    c.handleKey('', ENTER);
    await flush();
    c.handleKey('', ENTER); // accept the (only, ALREADY-bound) model
    await flush();

    expect(reseatChat).not.toHaveBeenCalled(); // no pointless reseat onto the current model
    expect(sessionA.teardown).not.toHaveBeenCalled(); // the live session is untouched
    expect(c.getSnapshot().modelPicker?.hint).toContain('Already on'); // the picker stays open with a hint
  });

  it('in-Home chat: /effort opens the interactive tier overlay; applying pushes the setter — NO reseat (ADR-0066 §6)', async () => {
    // The standalone `/effort` overlay (distinct from the `/models` effort sub-step): a reasoning-capable live chat
    // opens a fixed tier list on the bound effort; picking a new tier pushes the per-turn session override, never a
    // reseat. Reached via the `/` palette (typing `/` opens it), matching how a user runs it.
    const boundStore = createChatStore(
      false,
      { model: 'claude-opus-4-8', transcript: [] },
      INLINE_TRANSCRIPT_BOUND,
    );
    boundStore.setReasoningEffort('low'); // the session's current tier — drives the overlay's ✓/opening highlight
    const onSetEffort = vi.fn();
    const sessionA = makeSession({ sessionId: 'sess-A', store: boundStore, onSetEffort });
    const reseatChat = vi.fn(() => Promise.resolve(makeSession().session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(sessionA.session),
      reseatChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    c.handleKey('/', {}); // open the `/` palette
    type(c, 'effort'); // filter CHAT_PALETTE_COMMANDS → [/effort]
    c.handleKey('', ENTER); // run /effort → the interactive overlay opens (NOT the model picker)
    expect(c.getSnapshot().effortPicker?.current).toBe('low');
    expect(c.getSnapshot().effortPicker?.selected).toBe(REASONING_EFFORTS.indexOf('low'));
    expect(c.getSnapshot().modelPicker).toBeUndefined();
    c.handleKey('', { downArrow: true }); // low → medium
    c.handleKey('', { downArrow: true }); // medium → high
    c.handleKey('', ENTER); // apply 'high'

    expect(onSetEffort).toHaveBeenCalledWith('high'); // the per-turn SESSION override
    expect(reseatChat).not.toHaveBeenCalled(); // an effort change is NOT a reseat (ADR-0066 §5)
    expect(sessionA.teardown).not.toHaveBeenCalled(); // the live session is untouched
    expect(c.getSnapshot().effortPicker).toBeUndefined(); // the overlay closed after applying
  });

  it('in-Home chat: /effort on a NON-reasoning model does NOT open the overlay — it dispatches to the notice (ADR-0066 §6)', async () => {
    // A non-reasoning bound model has no controllable tier, so `/effort` must fall through to the slash dispatch
    // (the ctx handler prints "no controllable tier"), never opening a dead overlay.
    const boundStore = createChatStore(
      false,
      { model: 'gpt-4o', transcript: [] },
      INLINE_TRANSCRIPT_BOUND,
    ); // gpt-4o is not a reasoning model
    const onSetEffort = vi.fn();
    const made = makeSession({ store: boundStore, onSetEffort });
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
    c.handleKey('/', {});
    type(c, 'effort');
    c.handleKey('', ENTER);
    await flush();

    expect(c.getSnapshot().effortPicker).toBeUndefined(); // no overlay for a non-reasoning model
    expect(made.lines).toContain('/effort'); // it dispatched (the ctx handler surfaces the "no tier" notice)
    expect(onSetEffort).not.toHaveBeenCalled();
  });

  it('in-Home chat: a typed (pasted) /effort line opens the overlay via applySubmitAction (ADR-0066 §6)', async () => {
    // Typing `/` at an empty prompt opens the palette, so a LITERAL `/effort` line reaches applySubmitAction only via
    // paste (bracketed paste appends verbatim). This covers the typed-intercept branch, distinct from the palette one.
    const boundStore = createChatStore(
      false,
      { model: 'claude-opus-4-8', transcript: [] },
      INLINE_TRANSCRIPT_BOUND,
    );
    boundStore.setReasoningEffort('medium');
    const onSetEffort = vi.fn();
    const sessionA = makeSession({ store: boundStore, onSetEffort });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(sessionA.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    c.handlePaste('/effort'); // pasted literally — the `/` intercept is bypassed (paste is a usePaste event, not a key)
    expect(c.getSnapshot().input.text).toBe('/effort');
    c.handleKey('', ENTER); // submit the literal line → applySubmitAction → the typed intercept opens the overlay

    expect(c.getSnapshot().effortPicker?.current).toBe('medium'); // opened on the bound tier
    expect(c.getSnapshot().input.text).toBe(''); // the buffer was cleared
    expect(sessionA.lines).not.toContain('/effort'); // it did NOT dispatch — it opened the overlay
  });

  it('in-Home chat: Esc closes the /effort overlay without applying; same-tier re-pick is a no-op (ADR-0066 §6)', async () => {
    const boundStore = createChatStore(
      false,
      { model: 'claude-opus-4-8', transcript: [] },
      INLINE_TRANSCRIPT_BOUND,
    );
    boundStore.setReasoningEffort('high'); // the overlay opens highlighted on 'high'
    const onSetEffort = vi.fn();
    const sessionA = makeSession({ store: boundStore, onSetEffort });
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () => Promise.resolve(sessionA.session),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    // Open via the palette, then Esc — closes the overlay without a setter call.
    c.handleKey('/', {});
    type(c, 'effort');
    c.handleKey('', ENTER);
    expect(c.getSnapshot().effortPicker).toBeDefined();
    c.handleKey('', { escape: true });
    expect(c.getSnapshot().effortPicker).toBeUndefined(); // Esc closed it
    expect(onSetEffort).not.toHaveBeenCalled(); // …applying nothing

    // Re-open and Enter on the ALREADY-bound 'high' → a gentle no-op (no setter call), overlay closed.
    c.handleKey('/', {});
    type(c, 'effort');
    c.handleKey('', ENTER);
    c.handleKey('', ENTER); // Enter on the opening highlight (the bound 'high')
    expect(onSetEffort).not.toHaveBeenCalled(); // same tier ⇒ no setter call
    expect(c.getSnapshot().effortPicker).toBeUndefined(); // closed
  });
});
