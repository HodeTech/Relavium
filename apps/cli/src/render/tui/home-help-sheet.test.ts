/**
 * A typed `/word` on the landing, and the `/help` sheet it opens
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3, MVP-8 step 5),
 * through the real Home controller: a line that starts with a slash is a command line and is always answered, never a message (the chat reads
 * every such line as a slash command, so a chat started for it could only say `unknown command`): a registry word is answered whatever
 * follows it, a word the registry does not know is said to be unknown, a line that is not a word is said to be unknown as the chat says it,
 * and the sheet owns every key while it is open. The pure
 * model of the sheet is `help-sheet.test.ts`; what is drawn is `home-help-sheet-app.test.tsx`. The run host, the ports and the timers are
 * scripted: no engine is built and no operator home is read.
 */
import { describe, expect, it, vi } from 'vitest';

import { HOME_PALETTE_COMMANDS, REPL_COMMANDS } from '../../commands/repl-commands.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import { HELP_SHEET_KEYS, HOME_KEYS, type HelpKeyPress } from './help-sheet.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import { filterPaletteCommands } from './palette-reducer.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const WITH_SESSION: HomeSnapshot = {
  ...EMPTY,
  recentSessions: [
    {
      sessionId: 'saved',
      title: 'Saved conversation',
      workingDir: '/workspace',
      agentSlug: 'chat',
      modelId: undefined,
      status: 'ended',
      updatedAt: '2026-11-10T00:00:00.000Z',
      totalCostMicrocents: 0,
    },
  ],
  isEmpty: false,
};

const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A Home over scripted ports, with no timers and a chat build that never finishes (so a started chat is a `startChat` call). */
function mount(options: { readonly snapshot?: HomeSnapshot } = {}) {
  const onExit = vi.fn();
  const startChat = vi.fn(() => new Promise<HomeChatSession>(() => {}));
  const deps: HomeControllerDeps = {
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat,
    homeStore: { read: () => options.snapshot ?? EMPTY },
    schedule: () => () => {},
    now: () => 1_000,
    onExit,
    onError: (cause) => {
      throw cause;
    },
  };
  return { controller: createHomeController(deps), onExit, startChat };
}
type Home = ReturnType<typeof mount>;

/** A line that enters the prompt as a paste does (so a `/` at the start does not open the palette), and is submitted. */
const pasted = (home: Home, text: string): void => {
  home.controller.handlePaste(text);
  home.controller.handleKey('', ENTER);
};
/** The same line typed key by key: its first `/` opens the palette, which then answers a word that matches nothing. */
const typed = (home: Home, text: string): void => {
  for (const char of text) home.controller.handleKey(char, {});
  home.controller.handleKey('', ENTER);
};
const press = (controller: HomeController, key: HelpKeyPress): void => {
  controller.handleKey(key.input, key.key);
};

const WORKS_IN_A_CHAT = (word: string): string =>
  `${word} works in a chat. Start one, then type it. /help lists the commands.`;

/**
 * What every word of the registry does at the landing, by name: the words a landing owns (`/help`, `/exit`, `/doctor`, `/clear`, `/models`),
 * the ones an earlier branch answers when its port is missing (`/mode`, `/permissions`, `/workflows`), and a chat's own (the rest).
 * The test fails for a registry name that is not here, so a new command has to be given its answer.
 */
const ANSWERS: Readonly<Record<string, (home: Home) => void | Promise<void>>> = {
  help: (home) => {
    expect(home.controller.getSnapshot().screen?.kind).toBe('help');
  },
  exit: (home) => {
    expect(home.onExit).toHaveBeenCalledOnce();
  },
  doctor: (home) => {
    expect(home.controller.getSnapshot().notice).toContain('doctor:');
  },
  clear: (home) => {
    expect(home.controller.getSnapshot().notice).toBe(
      'No active conversation to clear — type a message to start one.',
    );
  },
  models: (home) => {
    expect(home.controller.getSnapshot().notice).toBe('/models is unavailable here.');
  },
  mode: (home) => {
    expect(home.controller.getSnapshot().notice).toBe(
      'Startup mode settings are unavailable here.',
    );
  },
  permissions: (home) => {
    expect(home.controller.getSnapshot().notice).toBe(
      'Remembered commands are not available here.',
    );
  },
  workflows: (home) => {
    expect(home.controller.getSnapshot().notice).toBe(
      'The project’s workflows are not available here.',
    );
  },
};
const chatOnly = (name: string) => (home: Home) => {
  expect(home.controller.getSnapshot().notice).toBe(WORKS_IN_A_CHAT(`/${name}`));
};

describe('a registry word at the landing is answered, and never starts a chat', () => {
  it('covers every word of the registry', () => {
    const owned = Object.keys(ANSWERS);
    const names = REPL_COMMANDS.map((command) => command.name);
    for (const name of owned) expect(names, `${name} is a registry word`).toContain(name);
    // Every other word is a chat's: the registry says it works nowhere on the landing.
    for (const command of REPL_COMMANDS)
      if (!owned.includes(command.name))
        expect(command.availableIn, `/${command.name}`).not.toContain('home');
  });

  it.each(REPL_COMMANDS.map((command) => command.name))(
    'a pasted /%s starts no chat and sends nothing: it is answered',
    async (name) => {
      const home = mount();
      pasted(home, `/${name}`);
      await flush();
      expect(home.startChat, `/${name} starts no chat`).not.toHaveBeenCalled();
      const snapshot = home.controller.getSnapshot();
      expect(snapshot.mode).toBe('home');
      expect(snapshot.input.text, 'the line is cleared').toBe('');
      expect(snapshot.session).toBeUndefined();
      await (ANSWERS[name] ?? chatOnly(name))(home);
      await home.controller.teardownActive();
    },
  );

  it.each(REPL_COMMANDS.map((command) => command.name))(
    'a typed /%s is answered the same way, through the palette',
    async (name) => {
      const home = mount();
      typed(home, `/${name}`);
      await flush();
      expect(home.startChat, `/${name} starts no chat`).not.toHaveBeenCalled();
      const snapshot = home.controller.getSnapshot();
      expect(snapshot.palette, 'the palette is closed').toBeUndefined();
      expect(snapshot.mode).toBe('home');
      expect(snapshot.input.text).toBe('');
      // The palette filters on the descriptions too, so a word that matches a command of the Home's runs that command, as it always did
      // (`/export` matches the Home's `/workflows`: "run or export one"); one that matches nothing is the typed word, answered here.
      if (filterPaletteCommands(HOME_PALETTE_COMMANDS, name).length === 0)
        await (ANSWERS[name] ?? chatOnly(name))(home);
      await home.controller.teardownActive();
    },
  );

  it.each([
    ['/doctor --deep', '/doctor accepts no arguments here. Start a chat to use them.'],
    ['/cost --release', WORKS_IN_A_CHAT('/cost')],
  ])('a pasted "%s" is answered with its notice and runs nothing', async (line, notice) => {
    const home = mount();
    pasted(home, line);
    await flush();
    const snapshot = home.controller.getSnapshot();
    expect(snapshot.notice).toBe(notice);
    expect(snapshot.screen, 'no sheet opens for a line with arguments').toBeUndefined();
    expect(home.startChat).not.toHaveBeenCalled();
    expect(home.onExit).not.toHaveBeenCalled();
    expect(snapshot.input.text).toBe('');
    await home.controller.teardownActive();
  });
});

describe('Enter on a palette query that matches nothing, at the landing', () => {
  it('opens the sheet for help, answers a chat’s word and says a stranger is unknown', () => {
    const help = mount();
    typed(help, '/help');
    expect(help.controller.getSnapshot().screen?.kind).toBe('help');
    expect(help.controller.getSnapshot().palette).toBeUndefined();

    const cost = mount();
    typed(cost, '/cost');
    expect(cost.controller.getSnapshot().notice).toBe(WORKS_IN_A_CHAT('/cost'));

    const stranger = mount();
    typed(stranger, '/nosuchword');
    expect(stranger.controller.getSnapshot().notice).toBe(
      'Unknown command: /nosuchword. /help lists the commands.',
    );
    for (const home of [help, cost, stranger]) expect(home.startChat).not.toHaveBeenCalled();
  });

  it('a palette query that is a sentence is answered as its first word is: it opens no sheet and starts no chat', () => {
    const home = mount();
    typed(home, '/help me');
    expect(home.startChat).not.toHaveBeenCalled();
    expect(home.controller.getSnapshot().notice).toBe('/help accepts no arguments.');
    expect(home.controller.getSnapshot().screen).toBeUndefined();
    expect(home.controller.getSnapshot().palette).toBeUndefined();
    expect(home.controller.getSnapshot().input.text).toBe('');
  });

  it('still runs the command a query does match, and a first word that is not a lower-case word is said to be unknown, not sent', () => {
    const exit = mount();
    typed(exit, '/exit');
    expect(exit.onExit).toHaveBeenCalledOnce();

    const odd = mount();
    typed(odd, '/Zzzz');
    const snapshot = odd.controller.getSnapshot();
    expect(snapshot.palette).toBeUndefined();
    expect(snapshot.notice).toBe('Unknown command: /Zzzz. /help lists the commands.');
    expect(snapshot.screen).toBeUndefined();
    expect(snapshot.mode).toBe('home');
    expect(
      odd.startChat,
      'a line that starts with a slash is never a message',
    ).not.toHaveBeenCalled();
  });

  it('leaves the palette’s own Esc alone: nothing is answered', () => {
    const home = mount();
    home.controller.handleKey('/', {});
    for (const char of 'cost') home.controller.handleKey(char, {});
    home.controller.handleKey('', ESC);
    expect(home.controller.getSnapshot().palette).toBeUndefined();
    expect(home.controller.getSnapshot().notice).toBeUndefined();
  });
});

describe('a word the registry does not know', () => {
  it.each([
    ['pasted', pasted],
    ['typed', typed],
  ] as const)('is said to be unknown when %s, and starts no chat', async (_how, enter) => {
    const home = mount();
    enter(home, '/nosuchword');
    await flush();
    const snapshot = home.controller.getSnapshot();
    expect(snapshot.notice).toBe('Unknown command: /nosuchword. /help lists the commands.');
    expect(snapshot.mode).toBe('home');
    expect(snapshot.input.text).toBe('');
    expect(home.startChat).not.toHaveBeenCalled();
    await home.controller.teardownActive();
  });

  it.each([
    ['/inti', '/init'],
    ['/hlep', '/help'],
    ['/doctr', '/doctor'],
  ])('keeps the suggestion for a near miss: %s', (line, suggestion) => {
    const home = mount();
    pasted(home, line);
    expect(home.controller.getSnapshot().notice).toBe(
      `Unknown command. Did you mean ${suggestion}?`,
    );
    expect(home.startChat).not.toHaveBeenCalled();
  });

  it.each([
    '/Users/x/file.txt',
    '/etc/passwd',
    '/Users',
    '/Zzzz',
    '/a/b',
    '/Users/x/notes.md please read',
  ])(
    'a line that starts with a slash and is not a word (%s) is said to be unknown as the chat says it, and starts no chat',
    (line) => {
      const home = mount();
      pasted(home, line);
      const snapshot = home.controller.getSnapshot();
      expect(snapshot.notice).toBe(`Unknown command: ${line}. /help lists the commands.`);
      expect(snapshot.mode).toBe('home');
      expect(snapshot.input.text).toBe('');
      expect(
        home.startChat,
        'the chat would read it as a command, not send it',
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    // A registry word is answered whatever follows it: a Home word is told it takes no arguments, a chat's word where it works.
    ['/cost is high, can you check?', WORKS_IN_A_CHAT('/cost')],
    ['/export x.yaml', WORKS_IN_A_CHAT('/export')],
    ['/help me understand this', '/help accepts no arguments.'],
    ['/exit now', '/exit accepts no arguments here. Start a chat to use them.'],
    ['/doctor why is this slow', '/doctor accepts no arguments here. Start a chat to use them.'],
    // A lower-case word the registry does not know names the word, and not the sentence after it.
    ['/tmp has junk, please clean it', 'Unknown command: /tmp. /help lists the commands.'],
    ['/nosuchword and then some text', 'Unknown command: /nosuchword. /help lists the commands.'],
    // A near miss keeps its suggestion, with text after it as well.
    ['/inti the project please', 'Unknown command. Did you mean /init?'],
  ])(
    'a line that opens with a slash word and goes on as text (%s) is answered by its first word, and starts no chat',
    (line, notice) => {
      const home = mount();
      pasted(home, line);
      const snapshot = home.controller.getSnapshot();
      expect(snapshot.notice).toBe(notice);
      expect(snapshot.screen, 'no sheet opens for a line with text after the word').toBeUndefined();
      expect(snapshot.mode).toBe('home');
      expect(snapshot.input.text).toBe('');
      expect(
        home.startChat,
        'a line that starts with a slash is never a message',
      ).not.toHaveBeenCalled();
      expect(home.onExit).not.toHaveBeenCalled();
    },
  );

  it('shows a line that is not a word as the chat does: printable ASCII only, and at most 64 characters', () => {
    const control = mount();
    pasted(control, '/Users/x\u001b[31mred');
    expect(control.controller.getSnapshot().notice).toBe(
      'Unknown command: /Users/x?[31mred. /help lists the commands.',
    );

    const multiline = mount();
    pasted(multiline, '/Users/x\nsecond line é');
    expect(multiline.controller.getSnapshot().notice).toBe(
      'Unknown command: /Users/x?second line ?. /help lists the commands.',
    );

    const long = mount();
    pasted(long, `/Users/${'x'.repeat(100)}`);
    const notice = long.controller.getSnapshot().notice ?? '';
    expect(notice).toBe(`Unknown command: /Users/${'x'.repeat(57)}. /help lists the commands.`);
    for (const home of [control, multiline, long])
      expect(home.startChat, 'none of them is sent').not.toHaveBeenCalled();
  });

  it('a line that does not start with a slash is a message, whatever it holds', () => {
    for (const line of ['please clean /tmp', 'hello', ' text with /help inside']) {
      const home = mount();
      pasted(home, line);
      expect(home.startChat, line).toHaveBeenCalledOnce();
      expect(home.controller.getSnapshot().mode, line).toBe('loading');
      expect(home.controller.getSnapshot().notice, line).toBeUndefined();
    }
  });

  it('a bare slash word that matches nothing is answered at the landing, and is not sent', () => {
    const home = mount();
    pasted(home, '/zzqqx');
    expect(home.controller.getSnapshot().notice).toBe(
      'Unknown command: /zzqqx. /help lists the commands.',
    );
    expect(home.startChat).not.toHaveBeenCalled();
  });

  it('a help sheet is never opened over a screen that is already open', () => {
    const home = mount();
    expect(home.controller.openScreen('help')).toBe(true);
    expect(home.controller.openScreen('help')).toBe(false);
    expect(home.controller.getSnapshot().screen?.kind).toBe('help');
  });

  it('answers a word of any length: it is never sent either', () => {
    const home = mount();
    pasted(home, `/${'a'.repeat(200)}`);
    expect(home.controller.getSnapshot().notice).toMatch(/^Unknown command: \/a+\. \/help lists/u);
    expect(home.controller.getSnapshot().notice?.length).toBeLessThan(120);
    expect(home.startChat).not.toHaveBeenCalled();
  });

  it('does not treat a word inside a message as a command', () => {
    const home = mount();
    pasted(home, 'please run /cost for me');
    expect(home.startChat).toHaveBeenCalledOnce();
  });

  it('answers in a chat as it did: the chat’s own dispatch gets its own commands and its own unknown words', async () => {
    const lines: string[] = [];
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const session: HomeChatSession = {
      store,
      sessionId: 'sess-words',
      processLine: (line) => {
        lines.push(line);
        return Promise.resolve();
      },
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    const started = vi.fn(() => Promise.resolve(session));
    const onExit = vi.fn();
    const controller = createHomeController({
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      startChat: started,
      homeStore: { read: () => EMPTY },
      schedule: () => () => {},
      now: () => 1_000,
      onExit,
      onError: (cause) => {
        throw cause;
      },
    });
    controller.handlePaste('hello');
    controller.handleKey('', ENTER);
    await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
    await vi.waitFor(() => expect(controller.getSnapshot().submitBusy).toBe(false));
    lines.length = 0;
    for (const line of ['/cost', '/nosuchword', '/help']) {
      controller.handlePaste(line);
      controller.handleKey('', ENTER);
      await vi.waitFor(() => expect(lines).toContain(line));
    }
    expect(controller.getSnapshot().screen, 'no sheet opens over a chat').toBeUndefined();
    expect(controller.getSnapshot().notice).toBeUndefined();
    expect(controller.openScreen('help'), 'the slot admits no screen over a chat').toBe(false);
    await controller.teardownActive();
  });
});

describe('the sheet owns every key while it is open', () => {
  const open = (home: Home): void => {
    expect(home.controller.openScreen('help')).toBe(true);
    expect(home.controller.getSnapshot().screen?.kind).toBe('help');
  };
  const same = (a: HelpKeyPress, b: HelpKeyPress): boolean =>
    a.input === b.input && JSON.stringify(a.key) === JSON.stringify(b.key);
  const closing = (key: HelpKeyPress): boolean =>
    HELP_SHEET_KEYS.close.presses.some((candidate) => same(candidate, key));

  it.each(HELP_SHEET_KEYS.close.presses)(
    'closes with %j, and leaves no screen, no armed interrupt and no exit behind',
    (key) => {
      const home = mount();
      open(home);
      press(home.controller, key);
      const snapshot = home.controller.getSnapshot();
      expect(snapshot.screen, 'the slot is empty again').toBeUndefined();
      expect(snapshot.interruptArmed).toBe(false);
      expect(home.onExit).not.toHaveBeenCalled();
      expect(home.startChat).not.toHaveBeenCalled();
      // The landing is back: its own keys work again.
      home.controller.handleKey('/', {});
      expect(home.controller.getSnapshot().palette).toBeDefined();
    },
  );

  it('names exactly the two closing presses: Esc and Ctrl+C', () => {
    expect(HELP_SHEET_KEYS.close.presses).toEqual([
      { input: '', key: { escape: true } },
      { input: 'c', key: { ctrl: true } },
    ]);
  });

  const homeKeyPresses = Object.entries(HOME_KEYS).flatMap(([id, key]) =>
    key.presses.map((keyPress) => [id, keyPress] as const),
  );
  it.each(homeKeyPresses)(
    'a key of the Home (%s: %j) does what it does only on the landing: here it leaves the sheet as it was, unless it is one that closes it',
    (_id, key) => {
      const home = mount({ snapshot: WITH_SESSION });
      open(home);
      press(home.controller, key);
      const snapshot = home.controller.getSnapshot();
      if (closing(key)) {
        expect(snapshot.screen).toBeUndefined();
      } else {
        expect(snapshot.screen?.kind, 'the sheet stays').toBe('help');
      }
      expect(snapshot.palette, 'no palette opens behind it').toBeUndefined();
      expect(snapshot.input.text, 'nothing is typed into the prompt').toBe('');
      expect(snapshot.stripFocus?.id, 'no row is moved onto').toBeUndefined();
      expect(snapshot.interruptArmed, 'no interrupt is armed').toBe(false);
      expect(home.startChat).not.toHaveBeenCalled();
      expect(home.onExit).not.toHaveBeenCalled();
    },
  );

  it('does nothing for a letter, an arrow or a paste, and Ctrl+D does not exit from it', () => {
    const home = mount({ snapshot: WITH_SESSION });
    open(home);
    for (const key of [
      { input: 'x', key: {} },
      { input: '', key: { upArrow: true } },
      { input: '', key: { leftArrow: true } },
      { input: 'd', key: { ctrl: true } },
      { input: '\t', key: {} },
    ] as const)
      press(home.controller, key);
    home.controller.handlePaste('typed behind the sheet');
    const snapshot = home.controller.getSnapshot();
    expect(snapshot.screen?.kind).toBe('help');
    expect(snapshot.input.text).toBe('');
    expect(home.onExit).not.toHaveBeenCalled();
    expect(home.startChat).not.toHaveBeenCalled();
  });

  it('opens from the landing only: not over an overlay, and not twice from a screen that is already open', () => {
    const home = mount();
    home.controller.handleKey('/', {});
    expect(home.controller.getSnapshot().palette).toBeDefined();
    expect(home.controller.openScreen('help'), 'refused while the palette is open').toBe(false);
    home.controller.handleKey('', ESC);
    expect(home.controller.openScreen('help')).toBe(true);
    home.controller.closeScreen();
    expect(home.controller.getSnapshot().screen, 'closeScreen is the one reset').toBeUndefined();
  });
});

/**
 * The keys the sheet names are the landing's own, and each does what its verb says there. This is the half of the claim the sheet's
 * Keys section makes (a hint cannot name a key that does not do it): the other half, that the sheet itself ignores them, is above.
 */
describe('every key the sheet names does what it says on the landing', () => {
  type Id = keyof typeof HOME_KEYS;
  const pressAll = (home: Home, id: Id): void => {
    for (const key of HOME_KEYS[id].presses) press(home.controller, key);
  };
  const landing: Readonly<Record<Id, () => void>> = {
    send: () => {
      const home = mount();
      home.controller.handlePaste('hello');
      pressAll(home, 'send');
      expect(home.startChat).toHaveBeenCalledOnce();
      expect(home.controller.getSnapshot().pendingMessage).toBe('hello');
    },
    newline: () => {
      const home = mount();
      home.controller.handleKey('a', {});
      pressAll(home, 'newline');
      home.controller.handleKey('b', {});
      expect(home.controller.getSnapshot().input.text).toBe('a\nb');
      expect(home.startChat).not.toHaveBeenCalled();
    },
    commands: () => {
      const home = mount();
      pressAll(home, 'commands');
      expect(home.controller.getSnapshot().palette).toBeDefined();
      // From an empty prompt only: with something typed, `/` is a character.
      const typedFirst = mount();
      typedFirst.controller.handleKey('a', {});
      pressAll(typedFirst, 'commands');
      expect(typedFirst.controller.getSnapshot().palette).toBeUndefined();
      expect(typedFirst.controller.getSnapshot().input.text).toBe('a/');
    },
    rows: () => {
      const home = mount({ snapshot: WITH_SESSION });
      pressAll(home, 'rows');
      expect(home.controller.getSnapshot().stripFocus?.id).toBe('saved');
      // From an empty prompt only: with something typed, `↓` moves nothing.
      const typedFirst = mount({ snapshot: WITH_SESSION });
      typedFirst.controller.handleKey('a', {});
      pressAll(typedFirst, 'rows');
      expect(typedFirst.controller.getSnapshot().stripFocus?.id).toBeUndefined();
    },
    back: () => {
      const home = mount({ snapshot: WITH_SESSION });
      pressAll(home, 'rows');
      expect(home.controller.getSnapshot().stripFocus?.id).toBe('saved');
      pressAll(home, 'back');
      expect(home.controller.getSnapshot().stripFocus?.id).toBeUndefined();
      expect(home.startChat).not.toHaveBeenCalled();
    },
    eof: () => {
      const home = mount();
      pressAll(home, 'eof');
      expect(home.onExit).toHaveBeenCalledOnce();
      // From an empty prompt only: with something typed it keeps the text.
      const typedFirst = mount();
      typedFirst.controller.handleKey('a', {});
      pressAll(typedFirst, 'eof');
      expect(typedFirst.onExit).not.toHaveBeenCalled();
      expect(typedFirst.controller.getSnapshot().input.text).toBe('a');
    },
    interrupt: () => {
      const home = mount();
      pressAll(home, 'interrupt');
      expect(home.controller.getSnapshot().interruptArmed, 'the first press only arms').toBe(true);
      expect(home.onExit).not.toHaveBeenCalled();
      pressAll(home, 'interrupt');
      expect(home.onExit, 'the second ends the Home').toHaveBeenCalledOnce();
    },
  };

  it('has a check for every key the sheet names', () => {
    expect(Object.keys(landing).sort()).toEqual(Object.keys(HOME_KEYS).sort());
  });
  it.each(Object.keys(HOME_KEYS) as Id[])('%s', (id) => {
    landing[id]();
  });
});
