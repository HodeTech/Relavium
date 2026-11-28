/**
 * `@` on the Home's own two prompts (ADR-0061 on the Home; the maintainer's question of 2026-11-26: `@` at the Home's prompt was a literal
 * character, while in a chat it opens the file picker). Through the real Home controller with a scripted reader and a scripted chat:
 *
 * - `@` at a word boundary opens the chat's picker over the Home's reader, on the landing and on the work page's docked prompt; a mid-word
 *   `@` stays a literal; nothing is read until a row is chosen (the listing reads names only);
 * - a chosen file inserts its compact `@path` marker and queues it as a pending attachment, exactly as in a chat (the dedup, the cap, the
 *   large-file warning), and a held `Enter` on the picker chooses at most one file;
 * - the landing's send carries the attachments into the FIRST message by the chat's own submit rule: expanded into the UNTRUSTED frame only when
 *   the marker survived; the pending message and the transcript show only the compact form;
 * - the attachments go with the draft (`Esc` on the landing, `Ctrl+C`'s clear, a command line, a key-shaped draft, a chat the draft did not start)
 *   and a read that resolves after the draft was sent, dropped or left is dropped; a refused read is one notification, never the Home's notice;
 * - a keyless Home keeps `@` working as a draft and sends nothing.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildAgentsModel, type AgentsModelItem } from '../../history/agents-model.js';
import type { AgentsPort } from '../../home/agents-port.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { HomePopupKind, HomePopupsPort } from '../../popups/home-port.js';
import {
  ATTACHMENTS_CLEARED,
  createHomeController,
  type HomeChatSession,
  type HomeControllerDeps,
} from './home-controller.js';
import { createChatStore } from './chat-store.js';
import { MAX_PENDING_ATTACHMENTS, PICK_ENTER_LOCKOUT_MS } from './attachments.js';
import type { MentionCandidate, MentionReadResult, MentionReader } from './mention.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  CTRL,
  DOWN,
  ENTER,
  ESC,
  settle,
  snapshotOf,
  until,
} from './home-controller.test-support.js';

const EMPTY: HomeSnapshot = { ...snapshotOf({}), isEmpty: true };
const WITH_SESSION = snapshotOf({
  recentSessions: [
    {
      sessionId: 's1',
      title: undefined,
      agentSlug: 'chat',
      modelId: undefined,
      status: 'ended',
      updatedAt: '2026-11-23T00:00:00.000Z',
      totalCostMicrocents: 0,
    },
  ],
  totals: { attention: 0, sessions: 1, runs: 0 },
});
const FILES: readonly MentionCandidate[] = [
  { name: 'src', type: 'directory', path: 'src' },
  { name: 'notes.md', type: 'file', path: 'notes.md' },
  { name: 'plan.md', type: 'file', path: 'plan.md' },
];
const CONTENT = 'THE-FILE-CONTENT-7c1d';

/** One ready agent of the project, as the agents browser lists it (its detail's `c` starts a chat bound to it). */
const REVIEWER: AgentsModelItem = {
  entry: {
    slug: 'reviewer',
    name: 'Code Reviewer',
    path: '.relavium/agents/reviewer.agent.yaml',
    valid: true,
  },
  agent: { model: 'claude-opus-4-8', provider: 'anthropic', system_prompt: 'You review code.' },
};
const AGENTS: AgentsPort = {
  read: () => ({
    model: buildAgentsModel([REVIEWER]),
    slugOf: () => 'reviewer',
    pathOf: () => REVIEWER.entry.path,
    definitionOf: () =>
      REVIEWER.agent === undefined ? undefined : { id: 'reviewer', ...REVIEWER.agent },
  }),
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RigOptions {
  readonly snapshot?: HomeSnapshot;
  readonly keyless?: boolean;
  /** Reads answered by hand (`reads`), instead of at once with {@link CONTENT}. */
  readonly manualReads?: boolean;
  readonly read?: MentionReader['read'];
  readonly startChat?: HomeControllerDeps['startChat'];
}

function rig(options: RigOptions = {}) {
  const pending: Deferred<MentionReadResult>[] = [];
  const list = vi.fn<MentionReader['list']>(() => Promise.resolve(FILES));
  const read = vi.fn<MentionReader['read']>(
    options.read ??
      (() => {
        if (options.manualReads !== true)
          return Promise.resolve({ content: CONTENT, sizeBytes: CONTENT.length });
        const next = deferred<MentionReadResult>();
        pending.push(next);
        return next.promise;
      }),
  );
  const sent: { line: string; display: string | undefined }[] = [];
  const announce = vi.fn<(text: string) => void>();
  const openProviders = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const session = (): HomeChatSession => ({
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: 'sess-mention',
    // The chat's own reader, over the same scripted files: the chat in front picks through it (`chatMentions`).
    mentionReader: { list, read },
    processLine: (line, display) => {
      sent.push({ line, display });
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  });
  const startChat = vi.fn<HomeControllerDeps['startChat']>(
    options.startChat ?? (() => Promise.resolve(session())),
  );
  const onExit = vi.fn();
  /** What the Home asked its popup host to open (`/agents` is a popup since MVP-11 unit 8; its `[c] chat` is a request the Home carries out). */
  const popups: { readonly kind: HomePopupKind; readonly port: HomePopupsPort }[] = [];
  // The Home's clock, moved by hand: an `Enter` inside the lockout after the `Enter` that chose a file is its repeat (`PickEnterLock`).
  let clock = 10_000;
  const c = createHomeController({
    startChat,
    homeStore: { read: () => options.snapshot ?? EMPTY },
    onExit,
    onError: (cause) => {
      throw cause;
    },
    now: () => clock,
    mentionReader: { list, read },
    agents: AGENTS,
    openHomePopup: (request) => {
      popups.push(request);
    },
    announce,
    providerSetup: {
      initialKeyless: options.keyless === true,
      open: openProviders,
      readKeyless: () => options.keyless === true,
    },
  });
  const type = (text: string): void => {
    for (const char of text) c.handleKey(char, {});
  };
  const advance = (ms: number): void => {
    clock += ms;
  };
  return {
    c,
    list,
    read,
    pending,
    sent,
    announce,
    startChat,
    popups,
    openProviders,
    onExit,
    type,
    advance,
  };
}
type Rig = ReturnType<typeof rig>;

/** Open the picker with `@` and wait for its listing. */
async function openPicker(r: Rig): Promise<void> {
  r.c.handleKey('@', {});
  await until(() => r.c.getSnapshot().mention?.loading === false);
}

/** Open the picker and choose `notes.md` (the second row: the directory is first), and let its read land. */
async function pickNotes(r: Rig): Promise<void> {
  await openPicker(r);
  r.c.handleKey('', DOWN);
  r.c.handleKey('', ENTER);
  await settle();
}

describe('@ opens the chat’s picker on the Home’s prompts', () => {
  it('at the landing’s empty prompt: the picker opens over the Home’s reader, which lists names and reads nothing', async () => {
    const r = rig();
    await openPicker(r);
    const mention = r.c.getSnapshot().mention;
    expect(mention?.candidates.map((candidate) => candidate.name)).toEqual([
      'src',
      'notes.md',
      'plan.md',
    ]);
    expect(r.list).toHaveBeenCalledWith('');
    expect(r.read, 'nothing is read until a row is chosen').not.toHaveBeenCalled();
    expect(r.c.getSnapshot().input.text, 'the `@` is the picker’s, not the draft’s').toBe('');
  });

  it('a mid-word `@` (an e-mail address) stays a literal character', () => {
    const r = rig();
    r.type('me@');
    expect(r.c.getSnapshot().mention).toBeUndefined();
    expect(r.c.getSnapshot().input.text).toBe('me@');
  });

  it('on the work page’s docked prompt too', async () => {
    const r = rig({ snapshot: WITH_SESSION });
    r.c.handleKey('', DOWN); // to the work page: its first row
    r.c.handleKey('', DOWN); // past the only row, onto the docked prompt
    expect(r.c.getSnapshot().homePage).toBe('work');
    expect(r.c.getSnapshot().stripFocus).toBeUndefined();
    await openPicker(r);
    expect(r.c.getSnapshot().mention).toBeDefined();
  });

  it('Esc closes it and gives the `@` and what was typed into it back to the draft; the palette and the picker never open together', async () => {
    const r = rig();
    await openPicker(r);
    r.c.handleKey('n', {}); // the picker's filter
    expect(r.c.getSnapshot().palette).toBeUndefined();
    r.c.handleKey('', ESC);
    expect(r.c.getSnapshot().mention).toBeUndefined();
    expect(r.c.getSnapshot().input.text).toBe('@n');
    // With the palette open, `@` is its query, never the picker.
    const p = rig();
    p.c.handleKey('/', {});
    p.c.handleKey('@', {});
    expect(p.c.getSnapshot().palette).toBeDefined();
    expect(p.c.getSnapshot().mention).toBeUndefined();
  });
});

describe('a chosen file is queued exactly as in a chat', () => {
  it('the compact `@path` marker is inserted and the file is a pending attachment; its content is never in the draft or a notice', async () => {
    const r = rig();
    await pickNotes(r);
    const state = r.c.getSnapshot();
    expect(r.read).toHaveBeenCalledExactlyOnceWith('notes.md');
    expect(state.input.text).toBe('@notes.md ');
    expect(state.attachments).toEqual([
      { kind: 'file', path: 'notes.md', content: CONTENT, sizeBytes: CONTENT.length },
    ]);
    expect(state.notice).toBeUndefined();
    expect(r.announce).not.toHaveBeenCalled();
  });

  it('the same file twice is one attachment (the dedup); a held Enter on the picker chooses at most one file', async () => {
    const r = rig({ manualReads: true });
    await openPicker(r);
    r.c.handleKey('', DOWN);
    for (let repeat = 0; repeat < 5; repeat += 1) r.c.handleKey('', ENTER);
    expect(r.read).toHaveBeenCalledOnce();
    r.pending[0]?.resolve({ content: CONTENT, sizeBytes: CONTENT.length });
    await settle();
    expect(r.c.getSnapshot().attachments.length).toBeLessThanOrEqual(1);
    const again = rig();
    await pickNotes(again);
    await pickNotes(again);
    expect(again.c.getSnapshot().attachments).toHaveLength(1);
  });

  it('a large file says so in one notification on the Home’s channel', async () => {
    const big = 'x'.repeat(40_000);
    const r = rig({ read: () => Promise.resolve({ content: big, sizeBytes: big.length }) });
    await pickNotes(r);
    expect(r.announce).toHaveBeenCalledWith(expect.stringMatching(/^@notes\.md is large/u));
    expect(r.c.getSnapshot().notice).toBeUndefined();
  });

  it(`the ${String(MAX_PENDING_ATTACHMENTS)}-attachment cap holds, and the drop is said`, async () => {
    const many: MentionCandidate[] = Array.from(
      { length: MAX_PENDING_ATTACHMENTS + 1 },
      (_, i) => ({
        name: `f${String(i)}.md`,
        type: 'file',
        path: `f${String(i)}.md`,
      }),
    );
    const r = rig();
    r.list.mockImplementation(() => Promise.resolve(many));
    for (let i = 0; i <= MAX_PENDING_ATTACHMENTS; i += 1) {
      r.c.handleKey(' ', {});
      await openPicker(r);
      for (let down = 0; down < i; down += 1) r.c.handleKey('', DOWN);
      r.c.handleKey('', ENTER);
      await settle();
    }
    expect(r.c.getSnapshot().attachments).toHaveLength(MAX_PENDING_ATTACHMENTS);
    expect(r.announce).toHaveBeenCalledWith(expect.stringContaining('pending attachment limit'));
  });

  it('a refused read (the floor, a binary, a size) adds nothing, keeps the draft, and is one notification, never the Home’s notice', async () => {
    const r = rig({ read: () => Promise.reject(new Error('refused: credential store')) });
    r.type('look at ');
    await pickNotes(r);
    expect(r.c.getSnapshot().attachments).toEqual([]);
    expect(r.c.getSnapshot().input.text).toBe('look at ');
    expect(r.announce).toHaveBeenCalledExactlyOnceWith(
      '@ mention could not read that file (refused, binary, or too large)',
    );
    expect(r.c.getSnapshot().notice).toBeUndefined();
  });
});

describe('the landing’s send carries them into the FIRST message, by the chat’s rule', () => {
  it('a surviving marker: the file is expanded into the untrusted frame of the first message; the pending message is the compact form', async () => {
    const r = rig();
    await pickNotes(r);
    r.type('summarise it');
    r.c.handleKey('', ENTER);
    expect(r.c.getSnapshot().pendingMessage).toBe('@notes.md summarise it');
    expect(r.c.getSnapshot().pendingMessage).not.toContain(CONTENT);
    await until(() => r.sent.length > 0);
    const [first] = r.sent;
    expect(first?.display).toBe('@notes.md summarise it');
    expect(first?.line.startsWith('@notes.md summarise it')).toBe(true);
    expect(first?.line).toContain(CONTENT);
    expect(first?.line).toMatch(/<file id="[0-9a-f]+" path="notes\.md">/u);
    expect(r.c.getSnapshot().attachments).toEqual([]);
  });

  it('a deleted marker: the file is not sent (the chat’s rule), and nothing of it rides into the chat', async () => {
    const r = rig();
    await pickNotes(r);
    for (let i = 0; i < '@notes.md '.length; i += 1) r.c.handleKey('', { backspace: true });
    r.type('just a question');
    r.c.handleKey('', ENTER);
    await until(() => r.sent.length > 0);
    expect(r.sent[0]?.line).toBe('just a question');
    expect(r.sent[0]?.line).not.toContain(CONTENT);
    expect(r.c.getSnapshot().attachments).toEqual([]);
  });

  it('a build that fails gives the draft back with its attachments', async () => {
    const r = rig({ startChat: () => Promise.reject(new Error('no model')) });
    await pickNotes(r);
    r.type('go');
    r.c.handleKey('', ENTER);
    await until(() => r.c.getSnapshot().mode === 'home');
    expect(r.c.getSnapshot().input.text).toBe('@notes.md go');
    expect(r.c.getSnapshot().attachments).toHaveLength(1);
  });

  it('a read that lands after a send whose build failed is dropped: the draft that came back gains no second marker', async () => {
    const r = rig({ manualReads: true, startChat: () => Promise.reject(new Error('no model')) });
    r.type('go ');
    await openPicker(r);
    r.c.handleKey('', DOWN);
    r.c.handleKey('', ENTER); // the read is on its way
    r.advance(2_500); // a deliberate Enter, past the lockout after the choice
    r.c.handleKey('', ENTER); // the draft is sent, and its build fails
    await until(() => r.c.getSnapshot().mode === 'home' && r.c.getSnapshot().input.text !== '');
    r.pending[0]?.resolve({ content: CONTENT, sizeBytes: CONTENT.length });
    await settle();
    expect(r.c.getSnapshot().input.text).toBe('go ');
    expect(r.c.getSnapshot().attachments).toEqual([]);
  });

  it('a read that lands after the draft was sent is dropped: the chat’s prompt gains no marker and nothing pending', async () => {
    const r = rig({ manualReads: true });
    r.type('first ');
    await openPicker(r);
    r.c.handleKey('', DOWN);
    r.c.handleKey('', ENTER);
    r.advance(2_500); // a deliberate Enter, past the lockout after the choice
    r.c.handleKey('', ENTER); // the draft is sent before the read lands
    await until(() => r.sent.length > 0);
    r.pending[0]?.resolve({ content: CONTENT, sizeBytes: CONTENT.length });
    await settle();
    expect(r.sent[0]?.line).toBe('first');
    expect(r.c.getSnapshot().input.text).toBe('');
    expect(r.c.getSnapshot().attachments).toEqual([]);
  });
});

describe('the attachments go with the draft', () => {
  it('Esc on the landing drops them (the chat’s clear) and says so once; the draft stays', async () => {
    const r = rig();
    await pickNotes(r);
    r.c.handleKey('', ESC);
    expect(r.c.getSnapshot().attachments).toEqual([]);
    expect(r.c.getSnapshot().input.text).toBe('@notes.md ');
    expect(r.announce).toHaveBeenCalledExactlyOnceWith(ATTACHMENTS_CLEARED);
  });

  it('the second Ctrl+C leaves the Home, and a read on its way lands nowhere', async () => {
    const r = rig({ manualReads: true });
    await openPicker(r);
    r.c.handleKey('', DOWN);
    r.c.handleKey('', ENTER);
    r.c.handleKey('c', CTRL);
    r.c.handleKey('c', CTRL);
    expect(r.onExit).toHaveBeenCalledOnce();
    r.pending[0]?.resolve({ content: CONTENT, sizeBytes: CONTENT.length });
    await settle();
    expect(r.c.getSnapshot().input.text).toBe('');
    expect(r.c.getSnapshot().attachments).toEqual([]);
  });

  it('a command line replaces the draft and drops them', async () => {
    const r = rig();
    await pickNotes(r);
    for (let i = 0; i < '@notes.md '.length; i += 1) r.c.handleKey('', { backspace: true });
    r.c.handlePaste('/help'); // typed at an empty prompt, `/` would open the palette instead
    r.c.handleKey('', ENTER);
    expect(r.c.getSnapshot().attachments).toEqual([]);
  });

  it('a chat the draft did not start (an agent’s, chosen from its detail) begins with nothing pending', async () => {
    const r = rig();
    await pickNotes(r);
    for (let i = 0; i < '@notes.md '.length; i += 1) r.c.handleKey('', { backspace: true });
    // The marker's deletion took the file along (round 2 sitting #3), so the palette's empty prompt has nothing pending to carry.
    expect(r.c.getSnapshot().attachments, 'gone with its marker').toEqual([]);
    r.c.handleKey('/', {}); // the palette, on the empty prompt
    r.type('agents');
    r.c.handleKey('', ENTER); // the agents popup
    expect(r.popups.map((request) => request.kind)).toEqual(['agents']);
    // `[c] chat` on the reviewer's detail: the popup hands the Home the catalog's path and the definition it drew, through the port the Home built.
    const agents = r.popups[0]?.port.agents;
    const listed = agents?.read();
    const path = listed?.pathOf(0);
    const definition = listed?.definitionOf(0);
    if (agents === undefined || path === undefined || definition === undefined)
      throw new Error('the Home gave the agents popup no agent to chat with');
    agents.chat({ path, listed: definition }); // a chat bound to it
    await until(() => r.c.getSnapshot().mode === 'chat');
    expect(r.startChat).toHaveBeenCalledOnce();
    expect(r.c.getSnapshot().attachments).toEqual([]);
  });

  it.each([
    ['a keyed Home', false],
    ['a keyless Home', true],
  ] as const)(
    'a draft that looks like a provider key takes them along when it is refused (%s)',
    async (_name, keyless) => {
      const r = rig({ keyless });
      await pickNotes(r);
      r.c.handlePaste('sk-ant-api03-mentionfakefakefake0123456789');
      r.c.handleKey('', ENTER);
      await settle();
      expect(r.c.getSnapshot().input.text).toBe('');
      expect(r.c.getSnapshot().attachments).toEqual([]);
      expect(r.sent).toEqual([]);
    },
  );

  it('a keyless Home keeps `@` working as a draft and sends nothing: Enter opens the provider setup, the draft and its attachment stay', async () => {
    const r = rig({ keyless: true });
    await pickNotes(r);
    r.type('read this');
    r.c.handleKey('', ENTER);
    await settle();
    expect(r.openProviders).toHaveBeenCalledOnce();
    expect(r.startChat).not.toHaveBeenCalled();
    expect(r.sent).toEqual([]);
    expect(r.c.getSnapshot().input.text).toBe('@notes.md read this');
    expect(r.c.getSnapshot().attachments).toHaveLength(1);
  });
});

/** Type `@path` as a person does with no pick: `@` opens the picker, the name is its filter, and `Esc` gives both back to the draft literally. */
function typeMarker(r: Rig, path: string): void {
  r.c.handleKey('@', {});
  r.type(path);
  r.c.handleKey('', ESC);
}

/** A chat in front of the Home, started by a first message `hi` (its line is then dropped from `sent`). */
async function inChat(r: Rig): Promise<void> {
  r.type('hi');
  r.c.handleKey('', ENTER);
  await until(() => r.c.getSnapshot().mode === 'chat' && r.sent.length > 0);
  r.sent.length = 0;
}

/**
 * A marker that left the draft takes its file along, for good (round 2 sitting #3, the medium finding): the Home draws no chip bar, so a file
 * whose marker was deleted, cleared or replaced stayed pending out of sight and rode the next message that named it, typed or pasted, with the
 * content read at the earlier pick. The three recipes of the sitting's real-binary run, on the landing and in the chat the Home hosts.
 */
describe.each(['the landing', 'the chat in front'] as const)(
  'on %s, a file whose marker left the draft is never sent',
  (where) => {
    const begin = async (): Promise<Rig> => {
      const r = rig();
      if (where === 'the chat in front') await inChat(r);
      return r;
    };
    const sentLine = async (r: Rig): Promise<string | undefined> => {
      await until(() => r.sent.length > 0);
      return r.sent[0]?.line;
    };

    it('atdel: pick, Ctrl+U, then type `@notes.md typedagain` and send: the line goes as plain text', async () => {
      const r = await begin();
      await pickNotes(r);
      expect(r.c.getSnapshot().attachments).toHaveLength(1);
      r.c.handleKey('u', CTRL);
      expect(r.c.getSnapshot().attachments, 'the cleared line took it along').toEqual([]);
      typeMarker(r, 'notes.md');
      r.type(' typedagain');
      expect(r.c.getSnapshot().input.text).toBe('@notes.md typedagain');
      expect(r.c.getSnapshot().attachments, 'a typed marker brings nothing back').toEqual([]);
      r.c.handleKey('', ENTER);
      expect(await sentLine(r)).toBe('@notes.md typedagain');
    });

    it('atbs2: pick, Backspace ×10, type `hello`, paste ` @notes.md please` and send: plain text', async () => {
      const r = await begin();
      await pickNotes(r);
      for (let i = 0; i < '@notes.md '.length; i += 1) r.c.handleKey('', { backspace: true });
      expect(r.c.getSnapshot().attachments).toEqual([]);
      r.type('hello');
      r.c.handlePaste(' @notes.md please');
      expect(r.c.getSnapshot().attachments, 'a pasted marker brings nothing back').toEqual([]);
      r.c.handleKey('', ENTER);
      expect(await sentLine(r)).toBe('hello @notes.md please');
    });

    it('atpal: pick, Ctrl+U, a command from the palette, then paste `@notes.md later` and send: plain text', async () => {
      const r = await begin();
      await pickNotes(r);
      r.c.handleKey('u', CTRL);
      r.c.handleKey('/', {}); // the palette, on the empty prompt
      r.type('help');
      r.c.handleKey('', ENTER); // the help sheet
      await settle();
      r.c.handleKey('', ESC); // closed again
      await settle();
      expect(r.c.getSnapshot().attachments).toEqual([]);
      r.sent.length = 0; // in a chat the palette's `/help` is a line of the chat's own: only what follows is the message
      r.c.handlePaste('@notes.md later');
      r.c.handleKey('', ENTER);
      expect(await sentLine(r)).toBe('@notes.md later');
    });

    it('a recalled line that names a file sent before brings nothing back either', async () => {
      const r = await begin();
      await pickNotes(r);
      r.type('first');
      r.c.handleKey('', ENTER);
      expect(await sentLine(r), 'sent with the file').toContain(CONTENT);
      if (where === 'the landing') return; // the landing's send started a chat: the recall below is the chat's
      r.sent.length = 0;
      await pickNotes(r);
      r.c.handleKey('u', CTRL);
      r.c.handleKey('', { upArrow: true }); // the input history's last line: `@notes.md first`
      expect(r.c.getSnapshot().input.text).toBe('@notes.md first');
      expect(r.c.getSnapshot().attachments).toEqual([]);
      r.c.handleKey('', ENTER);
      expect(await sentLine(r)).toBe('@notes.md first');
    });

    it('a marker still in the draft keeps its file through edits before it (motions, text typed, a line inserted above), and it is sent', async () => {
      const r = await begin();
      r.type('intro ');
      await pickNotes(r);
      r.c.handleKey('a', CTRL); // to the start of the line
      r.type('more ');
      r.c.handleKey('j', CTRL); // a line inserted above the marker's
      r.c.handleKey('', { leftArrow: true });
      r.c.handleKey('', { rightArrow: true });
      r.c.handleKey('e', CTRL); // to the end of the line
      expect(r.c.getSnapshot().input.text).toBe('more \nintro @notes.md ');
      expect(r.c.getSnapshot().attachments).toHaveLength(1);
      r.c.handleKey('', ENTER);
      expect(await sentLine(r)).toContain(CONTENT);
    });

    it('the first Ctrl+C: a draft it clears (in a chat) takes its files along; a draft it keeps (the landing arms the exit) keeps them', async () => {
      const r = await begin();
      await pickNotes(r);
      r.c.handleKey('c', CTRL);
      if (where === 'the chat in front') {
        expect(r.c.getSnapshot().input.text).toBe('');
        expect(r.c.getSnapshot().attachments).toEqual([]);
      } else {
        expect(r.c.getSnapshot().input.text).toBe('@notes.md ');
        expect(r.c.getSnapshot().attachments).toHaveLength(1);
      }
    });
  },
);

/**
 * The terminal's held-key grid: how long the first auto-repeat waits after the press (250 to 1800 ms), and how often it repeats then. A
 * quiet-gap rule cannot tell the first repeat from a deliberate press, so the lockout runs from the press that chose the file.
 */
const HELD_GRID = [250, 500, 660, 1800].flatMap((delay) =>
  [30, 100].map((rate) => [delay, rate] as const),
);

/**
 * A held `Enter` on the picker chooses the file and then sends nothing (round 2 sitting #3: on the landing its repeats started a chat that sent
 * the file, and in a chat they sent the message): the `Enter` that would send is held off for the lockout after the choice, and each repeat
 * inside it restarts it. A key typed since, or a patient `Enter` once the key was let go for the whole window, is the person's.
 */
describe.each(['the landing', 'the chat in front'] as const)(
  'on %s, a held Enter after the picker’s choice',
  (where) => {
    const begin = async (): Promise<Rig> => {
      const r = rig();
      if (where === 'the chat in front') await inChat(r);
      return r;
    };

    it.each(HELD_GRID)(
      'first repeat after %i ms, then every %i ms, for twice the lockout: one file chosen, nothing sent, no chat started',
      async (delay, rate) => {
        const r = await begin();
        const chats = r.startChat.mock.calls.length;
        await openPicker(r);
        r.c.handleKey('', DOWN);
        r.c.handleKey('', ENTER); // the press that chooses notes.md
        await settle(); // its read lands before the terminal's first repeat
        r.advance(delay);
        for (let held = 0; held < 2 * PICK_ENTER_LOCKOUT_MS; held += rate) {
          r.c.handleKey('', ENTER);
          r.advance(rate);
        }
        await settle();
        expect(r.read).toHaveBeenCalledOnce();
        expect(r.sent, 'nothing was sent').toEqual([]);
        expect(r.startChat.mock.calls.length, 'no chat was started').toBe(chats);
        expect(r.announce, 'no word for the repeats either').not.toHaveBeenCalled();
        expect(r.c.getSnapshot().input.text).toBe('@notes.md ');
        expect(r.c.getSnapshot().attachments).toHaveLength(1);
        // Let go for the whole window: the next Enter is a deliberate send, with the file.
        r.advance(PICK_ENTER_LOCKOUT_MS);
        r.c.handleKey('', ENTER);
        await until(() => r.sent.length > 0);
        expect(r.sent[0]?.line.startsWith('@notes.md')).toBe(true);
        expect(r.sent[0]?.line).toContain(CONTENT);
      },
    );

    it('a key typed right after the choice makes the next Enter the person’s: it sends at once', async () => {
      const r = await begin();
      await pickNotes(r);
      r.advance(20);
      r.type('x');
      r.advance(20);
      r.c.handleKey('', ENTER);
      await until(() => r.sent.length > 0);
      expect(r.sent[0]?.line.startsWith('@notes.md x')).toBe(true);
      expect(r.sent[0]?.line).toContain(CONTENT);
    });

    it('a paste right after the choice does too', async () => {
      const r = await begin();
      await pickNotes(r);
      r.c.handlePaste('read it');
      r.c.handleKey('', ENTER);
      await until(() => r.sent.length > 0);
      expect(r.sent[0]?.line.startsWith('@notes.md read it')).toBe(true);
    });
  },
);
