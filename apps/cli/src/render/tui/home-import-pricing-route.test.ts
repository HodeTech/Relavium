/**
 * `/import` and `/pricing` are Home commands ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, MVP-8 step 5): typed or pasted at the landing, or chosen from its palette, each opens its card on the native flow and shows the sentence
 * the card resolves with; with a chat in front neither is routed, and the chat's own dispatch answers the line.
 *
 * The cards themselves are `import-card.test.ts` and `pricing-card.test.ts`, the ports `import-port.test.ts` and `pricing-port.test.ts`, and
 * the wiring in `driveHome` is `drive-home.test.ts`. What is proved here is the controller's half: the route, the palette entry, the notices
 * and the hold on the keyboard while a card is open. The dependency is a spy, so "calls it exactly once" and "calls nothing" are counts.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ENTER = { return: true } as const;
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

/** The two words, the key of the dependency each one calls, and the sentences the controller says for them. */
const WORDS = [
  {
    word: '/import',
    dependency: 'importDefined',
    label: 'Import',
    withArguments: '/import accepts no arguments. It asks for the path.',
    unavailable: 'Import is unavailable in this session.',
  },
  {
    word: '/pricing',
    dependency: 'pricing',
    label: 'Model pricing',
    withArguments: '/pricing accepts no arguments.',
    unavailable: 'Model pricing is not available here.',
  },
] as const;

type Dependency = (typeof WORDS)[number]['dependency'];

interface Mounted {
  readonly controller: HomeController;
  readonly lines: string[];
  readonly onError: ReturnType<typeof vi.fn>;
  readonly onExit: ReturnType<typeof vi.fn>;
}

/** A Home with `deps` for the two cards (any of them absent) and a chat that records the lines it is handed. */
function mount(wired: Partial<Record<Dependency, () => Promise<string>>> = {}): Mounted {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const lines: string[] = [];
  const session: HomeChatSession = {
    store,
    sessionId: 'sess-import-pricing',
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
  const onError = vi.fn();
  const onExit = vi.fn();
  const deps: HomeControllerDeps = {
    ...(wired.importDefined === undefined ? {} : { importDefined: wired.importDefined }),
    ...(wired.pricing === undefined ? {} : { pricing: wired.pricing }),
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => Promise.resolve(session),
    homeStore: { read: () => EMPTY },
    onExit,
    onError,
  };
  return { controller: createHomeController(deps), lines, onError, onExit };
}

/** A card whose answer the test releases by hand, so the state while it is open can be read. */
function heldCard() {
  let release: (sentence: string) => void = () => {};
  let fail: (cause: unknown) => void = () => {};
  const card = vi.fn(
    () =>
      new Promise<string>((resolve, reject) => {
        release = resolve;
        fail = reject;
      }),
  );
  return { card, release: (sentence: string) => release(sentence), fail: (c: unknown) => fail(c) };
}

describe.each(WORDS)('$word at the landing', ({ word, dependency, label, ...says }) => {
  it('opens its card exactly once, clears the line, holds the keyboard while it is open and shows the sentence it resolves with', async () => {
    const held = heldCard();
    const { controller } = mount({ [dependency]: held.card });
    controller.handlePaste(word);
    controller.handleKey('', ENTER);
    expect(held.card).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().input.text, 'the line is cleared').toBe('');
    expect(
      controller.getSnapshot().nativeActionBusy,
      'the keyboard is the card’s while it is open',
    ).toBe(true);
    expect(controller.getSnapshot().session, 'no chat is started').toBeUndefined();
    held.release('The card’s own sentence.');
    await vi.waitFor(() => expect(controller.getSnapshot().nativeActionBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    expect(controller.getSnapshot().notice).toBe('The card’s own sentence.');
    expect(held.card, 'the card is not opened again by the answer').toHaveBeenCalledTimes(1);
  });

  it('is opened by the palette the same way: one open, the same sentence, the palette closed', async () => {
    const card = vi.fn(() => Promise.resolve('from the palette'));
    const { controller } = mount({ [dependency]: card });
    controller.handleKey('/', {}); // an empty prompt: the palette opens
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, word.slice(1));
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().palette, 'the palette is closed').toBeUndefined();
    await flush();
    expect(card).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().notice).toBe('from the palette');
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });

  it('takes no argument: it says so, and opens nothing', async () => {
    const card = vi.fn(() => Promise.resolve('unexpected'));
    const { controller } = mount({ [dependency]: card });
    controller.handlePaste(`${word} some/path.yaml`);
    controller.handleKey('', ENTER);
    await flush();
    expect(card).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toBe(says.withArguments);
    expect(controller.getSnapshot().input.text).toBe('');
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });

  it('says it is unavailable when its dependency is not wired, and holds nothing', async () => {
    const { controller } = mount();
    controller.handlePaste(word);
    controller.handleKey('', ENTER);
    await flush();
    expect(controller.getSnapshot().notice).toBe(says.unavailable);
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(controller.getSnapshot().session).toBeUndefined();
  });

  it('says it is unavailable from the palette too', () => {
    const { controller } = mount();
    controller.handleKey('/', {});
    type(controller, word.slice(1));
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().notice).toBe(says.unavailable);
    expect(controller.getSnapshot().palette).toBeUndefined();
  });

  it('a fault in the card becomes a notice that names no cause: the keyboard is given back and the Home goes on', async () => {
    const held = heldCard();
    const { controller, onError, onExit } = mount({ [dependency]: held.card });
    controller.handlePaste(word);
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().nativeActionBusy).toBe(true);
    held.fail(new Error('PRIVATE_FAULT_TEXT'));
    await vi.waitFor(() => expect(controller.getSnapshot().nativeActionBusy).toBe(false), {
      timeout: WAIT_MS,
    });
    expect(controller.getSnapshot().notice).toBe(`${label} could not be completed.`);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('PRIVATE_FAULT_TEXT');
    expect(onError, 'a card’s fault does not end the Home').not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    // The Home is still usable: the same word opens the card again.
    controller.handlePaste(word);
    controller.handleKey('', ENTER);
    expect(held.card).toHaveBeenCalledTimes(2);
    held.release('second time');
    await vi.waitFor(() => expect(controller.getSnapshot().notice).toBe('second time'), {
      timeout: WAIT_MS,
    });
  });

  it('a second request while the card is open opens nothing: one card at a time', () => {
    const held = heldCard();
    const { controller } = mount({ [dependency]: held.card });
    controller.handlePaste(word);
    controller.handleKey('', ENTER);
    expect(controller.getSnapshot().nativeActionBusy).toBe(true);
    // Every key is dropped while the card holds the keyboard, so the line is never submitted; the controller refuses a second open as well.
    controller.handlePaste(word);
    controller.handleKey('', ENTER);
    expect(held.card).toHaveBeenCalledTimes(1);
  });
});

describe.each(WORDS)('$word with a chat in front', ({ word, dependency }) => {
  it('is not routed to the card: nothing is opened and the keyboard is not held', async () => {
    const card = vi.fn(() => Promise.resolve('unexpected'));
    const { controller } = mount({ [dependency]: card });
    type(controller, 'hello');
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await flush();

    controller.handlePaste(word);
    controller.handleKey('', ENTER);
    await flush();

    expect(card, 'the card is a Home word: a chat never opens it').not.toHaveBeenCalled();
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(controller.getSnapshot().mode).toBe('chat');
  });

  it('is in no chat palette: choosing it by name there opens nothing', async () => {
    const card = vi.fn(() => Promise.resolve('unexpected'));
    const { controller } = mount({ [dependency]: card });
    type(controller, 'hello');
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await flush();
    controller.handleKey('/', {});
    expect(controller.getSnapshot().palette).toBeDefined();
    type(controller, word.slice(1));
    controller.handleKey('', ENTER);
    await flush();
    expect(card).not.toHaveBeenCalled();
    expect(controller.getSnapshot().nativeActionBusy).toBe(false);
  });
});

describe('what a chat does with the line of a word only the Home has', () => {
  /** A chat in front, and the lines its own dispatch was handed after `hello`. */
  async function inChat(): Promise<Mounted> {
    const m = mount({
      importDefined: () => Promise.resolve('unexpected'),
      pricing: () => Promise.resolve('unexpected'),
    });
    type(m.controller, 'hello');
    m.controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(m.controller.getSnapshot().mode).toBe('chat'), {
      timeout: WAIT_MS,
    });
    await flush();
    m.lines.length = 0;
    return m;
  }

  it.each(['/pricing', '/import'])(
    '%s is answered with one line that names the Home, in the transcript: it opens nothing, is not sent to the chat and is not an unknown command (ADR-0145 §7.4)',
    async (word) => {
      const m = await inChat();
      m.controller.handlePaste(word);
      m.controller.handleKey('', ENTER);
      await flush();
      const transcript =
        m.controller.getSnapshot().session?.store.getSnapshot().state.transcript ?? [];
      expect(
        transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : [])),
      ).toContain(`${word} is available from the Home.`);
      expect(
        m.controller.getSnapshot().notice,
        'not "Unknown command" and no suggestion',
      ).toBeUndefined();
      expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
      expect(m.lines, 'the line is not sent to the chat').toEqual([]);
    },
  );
});
