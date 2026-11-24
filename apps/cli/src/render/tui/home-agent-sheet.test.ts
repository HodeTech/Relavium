import { describe, expect, it, vi } from 'vitest';

import { boundAgentView, type BoundAgentView } from '../../chat/bound-agent-view.js';
import { buildDefaultChatAgent } from '../../chat/default-agent.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import type { PermissionsPort, PermissionsSnapshot } from '../../permissions/chat-permissions.js';
import type { DoctorProbes } from '../../chat/doctor.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { permissionsSheetOf } from './chat-sheet.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { toolReviewPage } from './tool-review-model.js';

/**
 * The `/agent` sheet in the in-Home chat (ADR-0140 §3), at the controller: it opens through the ONE sheet slot of the chat (the field
 * `chatSheet`, which ADR-0137's `/permissions` sheet also uses) and adds no field to the controller's state. What the sheet draws is
 * `agent-sheet.test.ts`; what the real session builder hands it is `drive-home.test.ts`.
 */

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const homeStore = { read: () => EMPTY, refresh: () => undefined } as unknown as HomeStore;
const PROBES: DoctorProbes = { keychain: () => {}, config: () => {}, toolHost: {} };

const SONNET: BoundAgentView = boundAgentView(
  buildDefaultChatAgent('claude-sonnet-4-6', undefined, 'anthropic'),
  undefined,
);
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const CTRL_C = { ctrl: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Keys, one character at a time: a leading `/` at an empty prompt opens the command PALETTE, which filters as the letters come. */
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};
/**
 * A whole line put in the prompt at once (a paste) and submitted, which is the TYPED-LINE path (`applySubmitAction`): no palette opens, so
 * what answers is the line's own interception, as it is for a line recalled from history or pasted.
 */
const submitLine = (c: HomeController, text: string): void => {
  c.handlePaste(text);
  c.handleKey('', ENTER);
};

const SNAPSHOT: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [{ id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' }],
  },
  session: [],
};
const PORT: PermissionsPort = { surface: 'chat', load: () => SNAPSHOT, withdraw: vi.fn() };

function makeSession(
  options: { boundAgent?: () => BoundAgentView; permissions?: PermissionsPort } = {},
): { session: HomeChatSession; lines: string[]; store: ChatStoreController } {
  const lines: string[] = [];
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const session: HomeChatSession = {
    store,
    sessionId: 'sess-fake',
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    ...(options.boundAgent === undefined ? {} : { boundAgent: options.boundAgent }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    teardown: () => Promise.resolve(),
  };
  return { session, lines, store };
}

async function inChat(made: ReturnType<typeof makeSession>): Promise<HomeController> {
  const c = createHomeController({
    doctorProbes: PROBES,
    startChat: () => Promise.resolve(made.session),
    homeStore,
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  type(c, 'hi');
  c.handleKey('', ENTER);
  await flush();
  return c;
}

async function openAgent(
  made: ReturnType<typeof makeSession>,
): Promise<{ c: HomeController; sent: string[] }> {
  const c = await inChat(made);
  const before = made.lines.length;
  submitLine(c, '/agent');
  await flush();
  return { c, sent: made.lines.slice(before) };
}

const agentView = (c: HomeController): BoundAgentView | undefined => {
  const sheet = c.getSnapshot().chatSheet;
  return sheet?.kind === 'agent' ? sheet.view : undefined;
};

describe('the /agent sheet in the in-Home chat (ADR-0140 §3)', () => {
  it('a typed bare /agent opens the sheet of the session’s own view instead of sending it, and clears the prompt', async () => {
    const { c, sent } = await openAgent(makeSession({ boundAgent: () => SONNET }));
    expect(c.getSnapshot().chatSheet?.kind).toBe('agent');
    expect(agentView(c), 'the view the session holds, not another').toBe(SONNET);
    expect(sent, 'nothing was dispatched').toEqual([]);
    expect(c.getSnapshot().input.text).toBe('');
  });

  it('opens from the palette as the typed command does: `agent` selects it first', async () => {
    const made = makeSession({ boundAgent: () => SONNET });
    const c = await inChat(made);
    c.handleKey('/', {});
    type(c, 'agent');
    c.handleKey('', ENTER);
    await flush();
    expect(agentView(c)).toBe(SONNET);
    expect(made.lines.filter((line) => line.startsWith('/'))).toEqual([]);
  });

  it('reads the view when it opens: a sheet opened after the session changed its model shows the model it has now', async () => {
    let current = SONNET;
    const opus = boundAgentView(
      buildDefaultChatAgent('claude-opus-4-8', undefined, 'anthropic'),
      undefined,
    );
    const made = makeSession({ boundAgent: () => current });
    const c = await inChat(made);
    submitLine(c, '/agent');
    expect(agentView(c)?.detail.model).toBe('claude-sonnet-4-6');
    c.handleKey('', ESC);
    current = opus;
    submitLine(c, '/agent');
    expect(agentView(c)?.detail.model).toBe('claude-opus-4-8');
  });

  it('is dispatched like any command where the session holds no view, and with an argument', async () => {
    const bare = await openAgent(makeSession({}));
    expect(bare.c.getSnapshot().chatSheet).toBeUndefined();
    expect(bare.sent).toEqual(['/agent']);
    const made = makeSession({ boundAgent: () => SONNET });
    const c = await inChat(made);
    submitLine(c, '/agent now');
    await flush();
    expect(c.getSnapshot().chatSheet, 'not intercepted: the dispatch rejects the argument').toBe(
      undefined,
    );
    expect(made.lines.at(-1)).toBe('/agent now');
  });

  it('does not open when the view cannot be made: the chat says so, and the prompt stays usable', async () => {
    const made = makeSession({
      boundAgent: () => {
        throw new Error('boom');
      },
    });
    const { c } = await openAgent(made);
    expect(c.getSnapshot().chatSheet).toBeUndefined();
    expect(made.store.getSnapshot().state.warnings).toContain('Could not read the agent.');
    type(c, 'x');
    expect(c.getSnapshot().input.text).toBe('x');
  });

  it('owns every key while open: typing, Enter and an arrow reach no prompt and send nothing; Esc closes it; Ctrl+C closes it and arms no exit', async () => {
    const made = makeSession({ boundAgent: () => SONNET });
    const { c } = await openAgent(made);
    const before = made.lines.length;
    type(c, 'hello');
    c.handleKey('', ENTER);
    c.handleKey('', { upArrow: true });
    c.handleKey('o', { ctrl: true });
    expect(c.getSnapshot().input.text).toBe('');
    expect(made.lines.slice(before), 'no key sent a line').toEqual([]);
    expect(c.getSnapshot().chatSheet?.kind, 'no key but Esc and Ctrl+C closes it').toBe('agent');
    c.handleKey('', ESC);
    expect(c.getSnapshot().chatSheet).toBeUndefined();
    submitLine(c, '/agent');
    expect(c.getSnapshot().chatSheet?.kind).toBe('agent');
    c.handleKey('c', CTRL_C);
    expect(c.getSnapshot().chatSheet).toBeUndefined();
    expect(c.getSnapshot().interruptArmed, 'a Ctrl+C that closes an overlay arms nothing').toBe(
      false,
    );
    type(c, 'again');
    expect(c.getSnapshot().input.text, 'the keyboard is the prompt’s again').toBe('again');
  });

  it('drops a paste: it reaches no prompt and the sheet is as it was', async () => {
    const { c } = await openAgent(makeSession({ boundAgent: () => SONNET }));
    c.handlePaste('please run everything');
    expect(c.getSnapshot().input.text).toBe('');
    expect(agentView(c)).toBe(SONNET);
    c.handleKey('', ESC);
    expect(c.getSnapshot().input.text, 'nor does it wait behind the sheet').toBe('');
  });

  it('holds the one sheet slot with /permissions: neither opens over the other, and each opens once the other is closed', async () => {
    const made = makeSession({ boundAgent: () => SONNET, permissions: PORT });
    const { c } = await openAgent(made);
    submitLine(c, '/permissions');
    expect(c.getSnapshot().chatSheet?.kind, 'the permissions command did not replace it').toBe(
      'agent',
    );
    c.handleKey('', ESC);
    submitLine(c, '/permissions');
    await flush();
    expect(c.getSnapshot().chatSheet?.kind).toBe('permissions');
    expect(permissionsSheetOf(c.getSnapshot().chatSheet)?.surface).toBe('chat');
    submitLine(c, '/agent');
    expect(c.getSnapshot().chatSheet?.kind, 'the agent command did not replace it').toBe(
      'permissions',
    );
    expect(made.lines.filter((line) => line.startsWith('/'))).toEqual([]);
    c.handleKey('', ESC);
    expect(
      c.getSnapshot().chatSheet,
      'Esc closed the permissions sheet: no question was up',
    ).toBeUndefined();
    submitLine(c, '/agent');
    expect(agentView(c)).toBe(SONNET);
  });

  it('gives way to a card that arrives while it is open: a key the sheet would drop closes it instead, and is left to the card', async () => {
    const made = makeSession({ boundAgent: () => SONNET });
    const { c } = await openAgent(made);
    let decided = false;
    void made.store
      .requestApproval({ toolId: 'write_file', action: 'fs_write', preview: { path: 'x' } }, true)
      .then(() => {
        decided = true;
      });
    made.store.bindReviewVisibility(() => true);
    const review = made.store.getSnapshot().review;
    if (review === undefined) throw new Error('no approval card is open');
    made.store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 24));
    // Not `Esc`: an open agent sheet closes on `Esc` anyway, so it would pass without the card's say. `x` is a key the sheet drops, and it
    // is closed by the pending card, not by the key.
    c.handleKey('x', {});
    expect(c.getSnapshot().chatSheet, 'the card won: the sheet is gone').toBeUndefined();
    await flush();
    expect(decided, 'the key was not an answer; the card is still waiting for its own').toBe(false);
    expect(made.store.getSnapshot().review, 'and still on screen').toBeDefined();
  });

  it('adds no field to the controller state: a snapshot holds the one chatSheet slot and nothing named for the agent', async () => {
    const { c } = await openAgent(makeSession({ boundAgent: () => SONNET }));
    const names = Object.keys(c.getSnapshot());
    expect(names).toContain('chatSheet');
    expect(names.filter((name) => /agent/iu.test(name))).toEqual([]);
  });
});

describe('/agent at the landing (ADR-0140 §3)', () => {
  const landing = (): { c: HomeController; startChat: ReturnType<typeof vi.fn> } => {
    const startChat = vi.fn(() =>
      Promise.resolve(makeSession({ boundAgent: () => SONNET }).session),
    );
    const c = createHomeController({
      doctorProbes: PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    return { c, startChat };
  };

  it('is answered with the chat-only notice, starts no chat and opens no sheet', async () => {
    const { c, startChat } = landing();
    submitLine(c, '/agent');
    await flush();
    expect(c.getSnapshot().notice).toBe(
      '/agent works in a chat. Start one, then type it. /help lists the commands.',
    );
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().chatSheet).toBeUndefined();
    expect(startChat).not.toHaveBeenCalled();
  });

  it('is answered the same with text after it', async () => {
    const { c, startChat } = landing();
    submitLine(c, '/agent please');
    await flush();
    expect(c.getSnapshot().notice).toContain('/agent works in a chat.');
    expect(c.getSnapshot().mode).toBe('home');
    expect(startChat).not.toHaveBeenCalled();
  });

  it('is not a command of the landing’s palette: whatever the palette selects for the letters, no sheet and no chat opens', async () => {
    const { c, startChat } = landing();
    c.handleKey('/', {});
    type(c, 'agent');
    expect(c.getSnapshot().palette?.state.query).toBe('agent');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().chatSheet).toBeUndefined();
    expect(startChat).not.toHaveBeenCalled();
  });
});
