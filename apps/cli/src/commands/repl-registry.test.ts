import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  availabilityOf,
  commandDefinitionsOf,
  commandsOf,
  formatReplHelp,
  HOME_CHAT_PALETTE_COMMANDS,
  HOME_PALETTE_COMMANDS,
  homeOnlyPointer,
  placementOf,
  replCommandList,
  REPL_COMMANDS,
  REPL_COMMANDS_BY_NAME,
  unavailableNotice,
  type CommandDefinition,
  type CommandGroup,
  type PaletteSurface,
  type SurfaceClass,
} from './repl-commands.js';

/**
 * The one command table (ADR-0145 §7, MVP-11 Step 2.2): every definition's fields, the exact order of each surface (the contract the
 * palette is pinned to), the surface classes, the availability rules and the pointer a chat answers to a Home-only word. The palette's rows
 * built from it are `palette-entries.test.ts`; the Home's dispatch of every placement is `home-registry-dispatch.test.ts`.
 */

/** The order of each surface, group by group (MVP-11 Appendix B as ADR-0145 refined it). Changes only with a recorded reason. */
const HOME_ORDER = [
  // work
  'resume',
  'run',
  'workflows',
  'agents',
  // setup
  'providers',
  'models',
  'mode',
  'permissions',
  'pricing',
  'init',
  'import',
  // check
  'doctor',
  'help',
  // end
  'clear',
  'exit',
] as const;

const CHAT_ORDER = [
  // model
  'models',
  'mode',
  'effort',
  'thinking',
  'permissions',
  // context
  'trim',
  'compact',
  // inspect
  'cost',
  'details',
  'agent',
  'workflows',
  'doctor',
  'help',
  // takeaway
  'copy',
  'export',
  'edit',
  'scrollback',
  // end
  'clear',
  'cancel',
  'exit',
] as const;

/** The Home-hosted chat: a chat's list with `/resume` first in *End* (and without `/providers` and `/init`, OD-2). */
const HOME_CHAT_ORDER = [
  ...CHAT_ORDER.slice(0, CHAT_ORDER.indexOf('clear')),
  'resume',
  'clear',
  'cancel',
  'exit',
] as const;

const names = (commands: readonly { readonly name: string }[]): string[] =>
  commands.map((command) => command.name);

/** The three surfaces. A `Record` over the type makes a surface added to it a compile error here, not a surface the tests forget. */
const SURFACE_SET: Readonly<Record<PaletteSurface, true>> = {
  home: true,
  chat: true,
  'home-chat': true,
};
const PALETTE_SURFACES = Object.keys(SURFACE_SET) as readonly PaletteSurface[];

/** Every definition the table holds, once: the union of what the three surfaces offer (the table itself is not exported: nothing but tests reads it). */
const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  ...new Map(
    PALETTE_SURFACES.flatMap((surface) => commandDefinitionsOf(surface)).map(
      (definition) => [definition.name, definition] as const,
    ),
  ).values(),
];

/** A definition by its slash name. */
const DEFINITION_BY_NAME: ReadonlyMap<string, CommandDefinition> = new Map(
  COMMAND_DEFINITIONS.map((definition) => [definition.name, definition]),
);

/** The groups of a surface in the order its commands list them, each once: read off the surface's own order, so a group that is not the surface's would show. */
const groupsOf = (surface: PaletteSurface): CommandGroup[] => [
  ...new Set(
    commandDefinitionsOf(surface).flatMap((definition) => {
      const group = definition.placements[surface]?.group;
      return group === undefined ? [] : [group];
    }),
  ),
];

/** What each placement is when it is chosen (ADR-0145 §1; MVP-11 Appendix A as refined). `chat` covers the Home-hosted chat as well. */
const CLASSES: Readonly<Record<string, Partial<Record<'home' | 'chat', SurfaceClass>>>> = {
  help: { home: 'screen', chat: 'popup' },
  exit: { home: 'instant', chat: 'instant' },
  cancel: { chat: 'instant' },
  export: { chat: 'popup' },
  agent: { chat: 'popup' },
  workflows: { home: 'screen', chat: 'popup' },
  cost: { chat: 'popup' },
  doctor: { home: 'popup', chat: 'popup' },
  mode: { home: 'popup', chat: 'popup' },
  effort: { chat: 'popup' },
  thinking: { chat: 'instant' },
  details: { chat: 'popup' },
  compact: { chat: 'instant' },
  permissions: { home: 'screen', chat: 'popup' },
  trim: { chat: 'instant' },
  clear: { home: 'instant', chat: 'instant' },
  models: { home: 'popup', chat: 'popup' },
  scrollback: { chat: 'instant' },
  edit: { chat: 'instant' },
  copy: { chat: 'instant' },
  providers: { home: 'popup' },
  init: { home: 'popup' },
  resume: { home: 'popup', chat: 'popup' },
  run: { home: 'popup' },
  agents: { home: 'screen' },
  import: { home: 'popup' },
  pricing: { home: 'popup' },
};

/**
 * The popup placements whose popup is NOT BUILT YET: every `popup` today, because Step 4 builds the popup host (MVP-11 §6). A popup placement
 * is in exactly one of two places: this list, or {@link POPUP_MODULES}. A new popup placement is in neither and fails until it is built or
 * listed here; a built popup leaves this list for the modules (a placement in both fails, so an entry cannot outlive its popup). A command on
 * the list has an increment that owes it ({@link BUILT_BY}).
 */
const POPUP_NOT_BUILT_YET: readonly string[] = [
  'home:doctor',
  'home:mode',
  'home:models',
  'home:providers',
  'home:init',
  'home:resume',
  'home:run',
  'home:import',
  'home:pricing',
  'chat:help',
  'chat:export',
  'chat:agent',
  'chat:workflows',
  'chat:cost',
  'chat:doctor',
  'chat:mode',
  'chat:effort',
  'chat:details',
  'chat:permissions',
  'chat:models',
  'home-chat:help',
  'home-chat:export',
  'home-chat:agent',
  'home-chat:workflows',
  'home-chat:cost',
  'home-chat:doctor',
  'home-chat:mode',
  'home-chat:effort',
  'home-chat:details',
  'home-chat:permissions',
  'home-chat:models',
  'home-chat:resume',
];

/**
 * The popup placements that ARE BUILT: `surface:name` to the module (relative to `apps/cli/src`) that implements the popup. Empty until the
 * popup host exists (Step 4a); the first popup built moves its placements here from {@link POPUP_NOT_BUILT_YET}. The module has to exist.
 */
const POPUP_MODULES: Readonly<Record<string, string>> = {};

/** The increment of MVP-11 Step 4 (or Step 5b) that builds each command's popup (`docs/roadmap/phases/mvp-11.md`, Step 4 and Appendix A). */
const BUILT_BY: Readonly<Record<string, '4b' | '4c' | '4d' | '5b'>> = {
  // 4b · reports
  doctor: '4b',
  agent: '4b',
  cost: '4b',
  workflows: '4b',
  help: '4b',
  // 4c · settings
  mode: '4c',
  effort: '4c',
  models: '4c',
  permissions: '4c',
  // 4d · flows
  providers: '4d',
  init: '4d',
  import: '4d',
  pricing: '4d',
  resume: '4d',
  run: '4d',
  export: '4d',
  // 5b · the inspection popup
  details: '5b',
};

describe('the command table: one definition per name, with the fields every command declares', () => {
  it('has one definition per name, each with the fields of a definition', () => {
    const all = names(COMMAND_DEFINITIONS);
    expect(new Set(all).size, 'a name appears once').toBe(all.length);
    for (const definition of COMMAND_DEFINITIONS) {
      const at = `/${definition.name}`;
      expect(definition.name, at).toMatch(/^[a-z]+$/u);
      expect(['read', 'write', 'destructive'], `${at} effect`).toContain(definition.effect);
      // Exactly one handler: a `run` over a session's context, or the typed marker that the Home's one table of words opens it.
      expect(
        [typeof definition.run, definition.opener],
        `${at}: a run, or opener: 'home', and not both`,
      ).toSatisfy(
        (handler: [string, string | undefined]) =>
          (handler[0] === 'function') !== (handler[1] === 'home'),
      );
      expect(Object.keys(definition.placements).length, `${at} has a placement`).toBeGreaterThan(0);
    }
  });

  it('gives every placement a group of its surface, a rank, words and a surface class', () => {
    for (const definition of COMMAND_DEFINITIONS) {
      for (const [surface, placement] of Object.entries(definition.placements)) {
        const at = `/${definition.name} on ${surface}`;
        expect(
          (PALETTE_SURFACES as readonly string[]).includes(surface),
          `${at}: a known surface`,
        ).toBe(true);
        expect(groupsOf(surface as PaletteSurface), `${at}: group ${placement.group}`).toContain(
          placement.group,
        );
        expect(Number.isInteger(placement.rank), `${at}: rank`).toBe(true);
        expect(placement.description.length, `${at}: description`).toBeGreaterThan(0);
        expect(placement.description, `${at}: one line`).not.toMatch(/[\r\n]/u);
        expect(['popup', 'screen', 'instant'], `${at}: surface class`).toContain(placement.surface);
      }
    }
  });

  it('never gives two commands of a surface the same group and rank (the order is total)', () => {
    for (const surface of PALETTE_SURFACES) {
      const seen = new Set<string>();
      for (const definition of commandDefinitionsOf(surface)) {
        const placement = definition.placements[surface];
        const key = `${placement?.group ?? ''}:${String(placement?.rank)}`;
        expect(seen.has(key), `${surface} ${key} (/${definition.name})`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('keeps each surface’s groups in the surface’s own order', () => {
    expect(groupsOf('home')).toEqual(['work', 'setup', 'check', 'end']);
    expect(groupsOf('chat')).toEqual(['model', 'context', 'inspect', 'takeaway', 'end']);
    expect(groupsOf('home-chat')).toEqual(groupsOf('chat'));
    // Each group is one run of the list: it is never split, and the groups never go back (a group not of the surface would sort first).
    for (const surface of PALETTE_SURFACES) {
      const sequence = commandDefinitionsOf(surface).map(
        (definition) => definition.placements[surface]?.group,
      );
      const runs = sequence.filter((group, index) => group !== sequence[index - 1]);
      expect(runs, `${surface}: every group is one run`).toEqual(groupsOf(surface));
    }
  });
});

describe('a command the Home opens carries a typed marker, not an empty handler (ADR-0145 §7)', () => {
  const OPENED = COMMAND_DEFINITIONS.filter((definition) => definition.opener === 'home');

  it('is exactly the Home’s own words: those that have no handler over a session’s context', () => {
    expect(names(OPENED).sort()).toEqual(
      ['agents', 'import', 'init', 'pricing', 'providers', 'resume', 'run'].sort(),
    );
    for (const definition of OPENED)
      expect(definition.run, `/${definition.name} has no handler here`).toBeUndefined();
  });

  it('is offered on the Home and on no stand-alone chat; the chat the Home hosts has only /resume of them', () => {
    for (const definition of OPENED) {
      expect(definition.placements.home, `/${definition.name} is on the Home`).toBeDefined();
      expect(
        definition.placements.chat,
        `/${definition.name} is on no stand-alone chat`,
      ).toBeUndefined();
    }
    const inHomeChat = OPENED.filter(
      (definition) => definition.placements['home-chat'] !== undefined,
    );
    expect(names(inHomeChat)).toEqual(['resume']);
    // A word the chat’s own dispatch can run is never one the Home opens: its list is the chat placements.
    for (const definition of OPENED)
      expect(REPL_COMMANDS_BY_NAME.has(definition.name), `/${definition.name}`).toBe(false);
  });

  it('is the only kind of command without a run: every other command has one', () => {
    for (const definition of COMMAND_DEFINITIONS.filter((entry) => entry.opener === undefined))
      expect(typeof definition.run, `/${definition.name}`).toBe('function');
  });
});

describe('the order of each surface is the contract (ADR-0145 §7.3)', () => {
  it('Home: Work, Set up, Check, End (15 entries)', () => {
    expect(names(commandDefinitionsOf('home'))).toEqual(HOME_ORDER);
    expect(names(HOME_PALETTE_COMMANDS)).toEqual(HOME_ORDER);
    expect(HOME_ORDER).toHaveLength(15);
  });

  it('a stand-alone chat: Model, Context, Inspect, Take away, End (20 entries)', () => {
    expect(names(commandDefinitionsOf('chat'))).toEqual(CHAT_ORDER);
    expect(names(REPL_COMMANDS)).toEqual(CHAT_ORDER);
    expect(CHAT_ORDER).toHaveLength(20);
  });

  it('the chat the Home hosts: a chat’s list with /resume first in End, without /providers and /init (21 entries)', () => {
    expect(names(commandDefinitionsOf('home-chat'))).toEqual(HOME_CHAT_ORDER);
    expect(names(HOME_CHAT_PALETTE_COMMANDS)).toEqual(HOME_CHAT_ORDER);
    expect(HOME_CHAT_ORDER).toHaveLength(21);
    expect(HOME_CHAT_ORDER.slice(-4)).toEqual(['resume', 'clear', 'cancel', 'exit']);
    for (const home of ['providers', 'init', 'import', 'pricing', 'run', 'agents'])
      expect(HOME_CHAT_ORDER, `/${home} is the Home's`).not.toContain(home);
  });

  it('/exit is the last entry of every surface, and no other command ends a list', () => {
    for (const surface of PALETTE_SURFACES)
      expect(names(commandDefinitionsOf(surface)).at(-1), surface).toBe('exit');
  });

  it('puts the commands that end something at the end: /clear and /cancel sit just above /exit', () => {
    for (const surface of PALETTE_SURFACES) {
      const order = names(commandDefinitionsOf(surface));
      expect(order.at(-2), surface).toBe(surface === 'home' ? 'clear' : 'cancel');
      expect(order.indexOf('clear'), `${surface}: /clear`).toBeGreaterThan(order.length - 5);
    }
  });
});

describe('the surface classes are declared data (ADR-0145 §1)', () => {
  it('every placement of every command has the class the plan gives it', () => {
    for (const definition of COMMAND_DEFINITIONS) {
      const expected = CLASSES[definition.name];
      expect(expected, `/${definition.name} has a row in the pinned table`).toBeDefined();
      for (const surface of PALETTE_SURFACES) {
        const placement = definition.placements[surface];
        const key = surface === 'home' ? 'home' : 'chat';
        expect(placement?.surface, `/${definition.name} on ${surface}`).toBe(
          placement === undefined ? undefined : expected?.[key],
        );
      }
    }
    expect(Object.keys(CLASSES).sort()).toEqual(names(COMMAND_DEFINITIONS).sort());
  });

  /** Every `surface:name` whose placement is a popup. */
  const popupPlacements = (): string[] =>
    COMMAND_DEFINITIONS.flatMap((definition) =>
      PALETTE_SURFACES.flatMap((surface) =>
        definition.placements[surface]?.surface === 'popup'
          ? [`${surface}:${definition.name}`]
          : [],
      ),
    );

  it('every popup placement is built (it has a module) or is named as not built yet, and never both or neither', () => {
    const popups = popupPlacements();
    const built = Object.keys(POPUP_MODULES);
    expect(
      popups.filter((key) => !POPUP_NOT_BUILT_YET.includes(key) && !built.includes(key)),
      'a popup that is neither built nor listed: build it or list it with its increment',
    ).toEqual([]);
    expect(
      POPUP_NOT_BUILT_YET.filter((key) => built.includes(key)),
      'a popup that is built and still listed as not built',
    ).toEqual([]);
    expect(
      [...POPUP_NOT_BUILT_YET, ...built].filter((key) => !popups.includes(key)),
      'a stale entry: the placement is gone or is no longer a popup',
    ).toEqual([]);
    expect(new Set(POPUP_NOT_BUILT_YET).size, 'a placement is listed once').toBe(
      POPUP_NOT_BUILT_YET.length,
    );
  });

  it('names the increment that owes each popup that is not built yet, and no increment for a command that has no popup', () => {
    for (const key of POPUP_NOT_BUILT_YET) {
      const name = key.slice(key.indexOf(':') + 1);
      expect(BUILT_BY[name], `${key} has an increment that builds it`).toBeDefined();
    }
    const withPopup = new Set(popupPlacements().map((key) => key.slice(key.indexOf(':') + 1)));
    expect(Object.keys(BUILT_BY).sort(), 'an increment for a command with no popup').toEqual(
      [...withPopup].sort(),
    );
  });

  it('a popup that is built names a module that exists', () => {
    for (const [key, module] of Object.entries(POPUP_MODULES))
      expect(
        existsSync(fileURLToPath(new URL(`../${module}`, import.meta.url))),
        `${key} is implemented by ${module}`,
      ).toBe(true);
  });
});

describe('what a surface says (ADR-0145 §7.4, §8)', () => {
  const description = (name: string, surface: PaletteSurface): string | undefined =>
    placementOf(name, surface)?.description;

  it('/exit says where it goes on each surface', () => {
    expect(description('exit', 'home')).toBe('Leave Relavium.');
    expect(description('exit', 'chat')).toBe('End the chat session.');
    expect(description('exit', 'home-chat')).toBe('Leave this chat and go back to the Home.');
  });

  it('/doctor on the Home does not advertise --deep, which the Home refuses (N5); a chat does', () => {
    expect(description('doctor', 'home')).toBe('Check your setup.');
    expect(description('doctor', 'chat')).toBe(
      'Check your setup; --deep also validates keys and MCP.',
    );
    expect(description('doctor', 'home-chat')).toBe(description('doctor', 'chat'));
  });

  it('/pricing names no shell command', () => {
    expect(description('pricing', 'home')).toBe('Set or clear your own price for a model.');
  });

  it('/mode fits one 80-column palette row with its name, on every surface that has it', () => {
    for (const surface of PALETTE_SURFACES) {
      const words = description('mode', surface);
      if (words === undefined) continue;
      // The row is `› /mode  ` then the words, and a row is cut at the terminal's width.
      expect(`› /mode  ${words}`.length, `${surface}: ${words}`).toBeLessThanOrEqual(80);
    }
    expect(description('mode', 'chat')).toBe('Choose the mode; Shift+Tab changes this chat only.');
  });

  it('a name shared by the Home and a chat is one definition with a placement each, and the words may differ', () => {
    for (const name of ['workflows', 'permissions', 'help']) {
      const definition = DEFINITION_BY_NAME.get(name);
      expect(definition?.placements.home, `/${name} on the Home`).toBeDefined();
      expect(definition?.placements.chat, `/${name} in a chat`).toBeDefined();
      expect(definition?.placements['home-chat'], `/${name} in the Home's chat`).toBeDefined();
    }
    expect(description('workflows', 'home')).not.toBe(description('workflows', 'chat'));
    expect(description('permissions', 'home')).not.toBe(description('permissions', 'chat'));
    // The derived lists hold ONE command object per (name, surface), with that surface's words.
    expect(HOME_PALETTE_COMMANDS.find((c) => c.name === 'workflows')?.description).toBe(
      description('workflows', 'home'),
    );
    expect(REPL_COMMANDS_BY_NAME.get('workflows')?.description).toBe(
      description('workflows', 'chat'),
    );
  });
});

describe('availability: a command that cannot act is shown dim with its reason, never hidden (ADR-0145 §7.4)', () => {
  const NOTHING = { hasSession: false, hasKey: false, hasSavedSessions: false, turnRunning: true };

  it('/clear on the bare Home is unavailable, with the reason a person reads', () => {
    expect(availabilityOf('clear', 'home', { hasSession: false })).toEqual({
      enabled: false,
      reason: 'no conversation to clear',
    });
    expect(availabilityOf('clear', 'chat', { hasSession: true })).toEqual({ enabled: true });
    expect(availabilityOf('clear', 'home-chat', { hasSession: true })).toEqual({ enabled: true });
  });

  it('/resume is unavailable when there is nothing to resume, on the Home and in the chat it hosts', () => {
    for (const surface of ['home', 'home-chat'] as const) {
      expect(availabilityOf('resume', surface, { hasSavedSessions: false }), surface).toEqual({
        enabled: false,
        reason: 'nothing to resume',
      });
      expect(availabilityOf('resume', surface, { hasSavedSessions: true }), surface).toEqual({
        enabled: true,
      });
    }
  });

  it('an unknown value reads as enabled: a dim row is advisory, and the handler re-validates', () => {
    for (const surface of PALETTE_SURFACES)
      for (const definition of commandDefinitionsOf(surface))
        expect(
          availabilityOf(definition.name, surface, {}),
          `/${definition.name} on ${surface}`,
        ).toEqual({
          enabled: true,
        });
  });

  it('nothing else dims in v0.2.0: with every cached fact against it, only /clear on the Home and /resume go dim', () => {
    const dim: string[] = [];
    for (const surface of PALETTE_SURFACES)
      for (const definition of commandDefinitionsOf(surface))
        if (!availabilityOf(definition.name, surface, NOTHING).enabled)
          dim.push(`${surface}:${definition.name}`);
    expect(dim.sort()).toEqual(['home-chat:resume', 'home:clear', 'home:resume']);
  });

  it('/run stays enabled even with no key and no saved session: its popup shows the empty state', () => {
    expect(availabilityOf('run', 'home', NOTHING)).toEqual({ enabled: true });
  });

  it('says a command the surface does not offer is not available there', () => {
    expect(availabilityOf('providers', 'chat', {}).enabled).toBe(false);
    expect(availabilityOf('nope', 'home', {}).enabled).toBe(false);
  });

  it('an availability is a function of the context it is given: the same answer for an equal copy, and it reads nothing but the context’s own fields', () => {
    const FIELDS = new Set(['surface', 'hasSession', 'hasKey', 'hasSavedSessions', 'turnRunning']);
    const values = [undefined, true, false] as const;
    let checked = 0;
    for (const definition of COMMAND_DEFINITIONS)
      for (const [name, placement] of Object.entries(definition.placements)) {
        const available = placement.available;
        if (available === undefined) continue;
        const surface = PALETTE_SURFACES.find((candidate) => candidate === name);
        if (surface === undefined) throw new Error(`unknown surface ${name}`);
        for (const hasSession of values)
          for (const hasKey of values)
            for (const hasSavedSessions of values)
              for (const turnRunning of values) {
                const base = { surface, hasSession, hasKey, hasSavedSessions, turnRunning };
                const read: string[] = [];
                const watched = new Proxy(base, {
                  get: (target, name) => {
                    read.push(String(name));
                    const value: unknown = Reflect.get(target, name);
                    return value;
                  },
                });
                const label = `/${definition.name} on ${surface} with ${JSON.stringify(base)}`;
                const answer = available(watched);
                expect(available({ ...base }), label).toEqual(answer);
                expect(
                  read.filter((name) => !FIELDS.has(name)),
                  `${label} read a field the context does not have`,
                ).toEqual([]);
                checked += 1;
              }
      }
    expect(checked, 'at least the two availability functions were exercised').toBeGreaterThan(100);
  });
});

describe('a command typed where the surface does not offer it (ADR-0145 §7.4)', () => {
  const HOME_ONLY = ['providers', 'init', 'import', 'pricing', 'run', 'agents'];

  it.each([
    // The chat the Home hosts IS in the Home, so its line only names it; a stand-alone chat is not, so its line says how to get there.
    [
      'chat',
      (name: string) => `/${name} is available from the Home: start Relavium without arguments.`,
    ],
    ['home-chat', (name: string) => `/${name} is available from the Home.`],
  ] as const)(
    'answers one line that names the Home, in %s, for every command only the Home has',
    (surface, expected) => {
      for (const name of HOME_ONLY) {
        const line = homeOnlyPointer(name, surface);
        expect(line, `/${name}`).toBe(expected(name));
        expect(line, `/${name}`).not.toMatch(/unknown/iu);
      }
    },
  );

  it('points /resume out of a stand-alone chat (it has no saved list) but not out of the chat the Home hosts', () => {
    expect(homeOnlyPointer('resume', 'chat')).toBe(
      '/resume is available from the Home: start Relavium without arguments.',
    );
    expect(homeOnlyPointer('resume', 'home-chat')).toBeUndefined();
  });

  it('points nowhere for a command the surface offers, a word nothing has, and the Home itself', () => {
    for (const surface of PALETTE_SURFACES)
      for (const definition of commandDefinitionsOf(surface))
        expect(
          homeOnlyPointer(definition.name, surface),
          `/${definition.name} on ${surface}`,
        ).toBeUndefined();
    expect(homeOnlyPointer('nope', 'chat')).toBeUndefined();
    expect(homeOnlyPointer('cost', 'home')).toBeUndefined();
    expect(homeOnlyPointer('providers', 'home')).toBeUndefined();
  });

  it('names no shell command and no command of the chat: it is a sentence about the Home', () => {
    for (const name of HOME_ONLY)
      expect(homeOnlyPointer(name, 'home-chat')).not.toMatch(/relavium/iu);
  });

  it('says why a dim row did not run, as a sentence that is not "unknown command"', () => {
    expect(unavailableNotice('clear', 'no conversation to clear')).toBe(
      '/clear is unavailable: no conversation to clear.',
    );
  });
});

describe('the exports that were arrays are derived from the one table', () => {
  it('REPL_COMMANDS is the stand-alone chat’s order, and /help and the unknown-slash hint follow it', () => {
    expect(names(REPL_COMMANDS)).toEqual(CHAT_ORDER);
    expect(names(commandsOf('chat'))).toEqual(CHAT_ORDER);
    expect(replCommandList()).toBe(CHAT_ORDER.map((name) => `/${name}`).join(', '));
    const rows = formatReplHelp()
      .split('\n')
      .filter((line) => line.startsWith('  /'));
    expect(rows.map((row) => row.slice(3).split('  ')[0])).toEqual([...CHAT_ORDER]);
  });

  it('derives availableIn from the placements', () => {
    const availableIn = (name: string): readonly string[] | undefined =>
      REPL_COMMANDS_BY_NAME.get(name)?.availableIn;
    expect(availableIn('exit')).toEqual(['home', 'chat']);
    expect(availableIn('workflows')).toEqual(['home', 'chat']);
    expect(availableIn('cost')).toEqual(['chat']);
    expect(HOME_PALETTE_COMMANDS.find((c) => c.name === 'providers')?.availableIn).toEqual([
      'home',
    ]);
    expect(HOME_PALETTE_COMMANDS.find((c) => c.name === 'resume')?.availableIn).toEqual([
      'home',
      'chat',
    ]);
  });

  it('keeps one object per (name, surface), so a lookup and a list agree', () => {
    for (const command of REPL_COMMANDS)
      expect(REPL_COMMANDS_BY_NAME.get(command.name)).toBe(command);
    expect(commandsOf('chat')[0]).toBe(REPL_COMMANDS[0]);
  });

  it('freezes the table, its placements and the derived lists', () => {
    const exit: CommandDefinition | undefined = DEFINITION_BY_NAME.get('exit');
    expect(COMMAND_DEFINITIONS.every((definition) => Object.isFrozen(definition))).toBe(true);
    expect(Object.isFrozen(exit)).toBe(true);
    expect(Object.isFrozen(exit?.placements)).toBe(true);
    expect(Object.isFrozen(exit?.placements.home)).toBe(true);
    expect(Object.isFrozen(REPL_COMMANDS)).toBe(true);
    expect(Object.isFrozen(HOME_PALETTE_COMMANDS)).toBe(true);
    expect(Object.isFrozen(HOME_CHAT_PALETTE_COMMANDS)).toBe(true);
  });
});
