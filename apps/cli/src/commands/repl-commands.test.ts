import { describe, expect, it, vi } from 'vitest';

import {
  formatReplHelp,
  HOME_PALETTE_COMMANDS,
  HOME_CHAT_PALETTE_COMMANDS,
  replCommandList,
  REPL_COMMANDS,
  REPL_COMMANDS_BY_NAME,
  type ReplCommandContext,
} from './repl-commands.js';
import { buildPaletteEntries, filterPaletteEntries } from '../render/tui/palette-entries.js';

/**
 * DERIVED from `ReplCommandContext`, never hand-kept. Both this map and the `total` sum below used to enumerate the
 * capabilities by hand, and both silently stopped counting each newly added one — so a command that fired TWO
 * capabilities still totalled 1 (found twice: Step 5d, Step 6e). Adding a capability to the context now fails to
 * compile until the spy exists.
 */
/** A fully-spied REPL context — each capability is a spy so a command's `run` can be asserted to call exactly one. */
function spyContext(): { ctx: ReplCommandContext; calls: () => Map<string, number> } {
  const spies = {
    exit: vi.fn(),
    cancel: vi.fn(),
    exportSession: vi.fn(),
    help: vi.fn(),
    showWorkflows: vi.fn(),
    showAgent: vi.fn(),
    showCost: vi.fn(),
    managePermissions: vi.fn(),
    runDoctor: vi.fn(),
    setMode: vi.fn(),
    setReasoningEffort: vi.fn(),
    toggleReasoning: vi.fn(),
    openDetails: vi.fn(),
    compactHistory: vi.fn(),
    trimHistory: vi.fn(),
    clearSession: vi.fn(),
    openModels: vi.fn(),
    dumpScrollback: vi.fn(),
    editTranscript: vi.fn(),
    copyTranscript: vi.fn(),
  } satisfies Record<keyof ReplCommandContext, unknown>;

  return {
    ctx: spies,
    // A Map built from the spy map itself: no second list to fall out of step with the first, and no cast.
    calls: () => new Map(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length])),
  };
}

describe('curated REPL command registry (ADR-0056 amendment)', () => {
  it('has a small, alias-free set with unique names', () => {
    const names = REPL_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(REPL_COMMANDS_BY_NAME.size).toBe(names.length);
    // A stand-alone chat's palette order (ADR-0145 §7.3): the registry is derived from the one table, so `/help` and the unknown-slash hint
    // follow it. (The exact order of every surface is pinned in `repl-registry.test.ts`.)
    expect(names).toEqual([
      'models',
      'mode',
      'effort',
      'thinking',
      'permissions',
      'trim',
      'compact',
      'cost',
      'details',
      'agent',
      'workflows',
      'doctor',
      'help',
      'copy',
      'export',
      'edit',
      'scrollback',
      'clear',
      'cancel',
      'exit',
    ]);
  });

  it('/permissions takes no argument: it calls the capability once, with nothing typed after it', async () => {
    const spy = spyContext();
    await REPL_COMMANDS_BY_NAME.get('permissions')?.run(spy.ctx, []);
    expect(vi.mocked(spy.ctx.managePermissions)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spy.ctx.managePermissions).mock.calls[0]).toEqual([]);
    // The typed `--revoke` forms are gone (ADR-0137 §2): the command declares neither a flag nor a positional, so the dispatch rejects a
    // typed token before the capability runs.
    const command = REPL_COMMANDS_BY_NAME.get('permissions');
    expect(command?.args ?? []).toEqual([]);
    expect(command?.positional).toBeUndefined();
    // A rejected token says where the job went, since the typed forms have no replacement in the grammar.
    expect(command?.rejectHint).toBe('Open /permissions and press [d] on a row to withdraw it.');
  });

  it('/agent takes no argument and is a chat command: one capability, in the chat palette and /help, not in the bare Home’s palette (ADR-0140 §3)', async () => {
    const spy = spyContext();
    const command = REPL_COMMANDS_BY_NAME.get('agent');
    await command?.run(spy.ctx, []);
    expect(vi.mocked(spy.ctx.showAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spy.ctx.showAgent).mock.calls[0]).toEqual([]);
    // Zero-arg: no flag and no positional, so the dispatch rejects any typed token before the capability runs.
    expect(command?.args ?? []).toEqual([]);
    expect(command?.positional).toBeUndefined();
    expect(command?.effect).toBe('read');
    expect(command?.availableIn).toEqual(['chat']);
    expect(command?.description).toBe('Show the agent this chat is bound to.');
    for (const [name, set] of [
      ['CHAT', REPL_COMMANDS],
      ['HOME_CHAT', HOME_CHAT_PALETTE_COMMANDS],
    ] as const)
      expect(
        set.map((entry) => entry.name),
        name,
      ).toContain('agent');
    expect(formatReplHelp()).toContain('/agent  Show the agent this chat is bound to.');
    // The landing's palette is unchanged: `/agent` is a chat word, answered at the landing with the chat-only notice, never run there.
    expect(HOME_PALETTE_COMMANDS.map((entry) => entry.name)).not.toContain('agent');
  });

  it('/cost --release reaches the capability WITH the flag (#W15-3)', async () => {
    // ADR-0074 §1's escape hatch existed in code and no command called it. The `args.includes` binding is the
    // whole of what makes it reachable, so it needs its own row: presence in the command list proves nothing.
    const released = spyContext();
    await REPL_COMMANDS_BY_NAME.get('cost')?.run(released.ctx, ['--release']);
    expect(released.ctx.showCost).toHaveBeenCalledWith(true);

    const bare = spyContext();
    await REPL_COMMANDS_BY_NAME.get('cost')?.run(bare.ctx, []);
    expect(bare.ctx.showCost).toHaveBeenCalledWith(false); // the palette's bare form never releases
  });

  it('each command run() invokes EXACTLY its one capability', async () => {
    const cases: Array<[string, string]> = [
      // [command name, the capability it must call]
      ['help', 'help'],
      ['exit', 'exit'],
      ['cancel', 'cancel'],
      ['export', 'exportSession'],
      ['agent', 'showAgent'],
      ['workflows', 'showWorkflows'],
      ['cost', 'showCost'],
      ['permissions', 'managePermissions'],
      ['doctor', 'runDoctor'],
      ['mode', 'setMode'],
      ['effort', 'setReasoningEffort'],
      ['thinking', 'toggleReasoning'],
      ['details', 'openDetails'],
      ['compact', 'compactHistory'],
      ['trim', 'trimHistory'],
      ['clear', 'clearSession'],
      ['models', 'openModels'],
      // ADR-0068 §e (Step 5d). Without these two rows the run→capability binding of the two newest commands was
      // untested: cross-wiring `/scrollback` to `ctx.editTranscript` left the whole suite green (the name/palette/help
      // assertions only check PRESENCE). Adding a command to the pinned lists is not enough — its binding needs a row.
      ['scrollback', 'dumpScrollback'],
      ['edit', 'editTranscript'],
      ['copy', 'copyTranscript'],
    ];
    for (const [name, capability] of cases) {
      const { ctx, calls } = spyContext();
      await REPL_COMMANDS_BY_NAME.get(name)?.run(ctx, []); // run may be async — await so the spy is recorded (+ no unhandled rejection)
      const counts = calls();
      expect(counts.get(capability), `${name} → ${capability}`).toBe(1);
      // Sum EVERY capability, not a hand-kept list. The hand-kept version silently stopped counting each newly added
      // one — so a command that fired two capabilities would still have totalled 1 (Step-6e, and a Step-5d repeat).
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      expect(total, `${name} calls exactly one capability`).toBe(1);
    }
  });

  it('a command the Home opens has no handler to run: the flattened view refuses a call, and calls no capability', () => {
    // `opener: 'home'` commands are opened from the Home controller's table, never run over a session's context (ADR-0145 §7); a route that
    // reached one by mistake used to do nothing, silently. The seven words below are exactly the Home's own that the Home palette lists.
    const spy = spyContext();
    for (const name of ['providers', 'init', 'import', 'pricing', 'run', 'agents', 'resume']) {
      const command = HOME_PALETTE_COMMANDS.find((entry) => entry.name === name);
      expect(command, `/${name} is a command of the Home`).toBeDefined();
      expect(() => command?.run(spy.ctx, []), `/${name}`).toThrow(
        `/${name} is opened by the Home, not run over a session`,
      );
    }
    expect([...spy.calls().values()].every((count) => count === 0)).toBe(true);
  });

  it('/doctor passes --deep through to runDoctor', async () => {
    const { ctx } = spyContext();
    const doctor = REPL_COMMANDS_BY_NAME.get('doctor');
    await doctor?.run(ctx, []);
    await doctor?.run(ctx, ['--deep']);
    expect(ctx.runDoctor).toHaveBeenNthCalledWith(1, false);
    expect(ctx.runDoctor).toHaveBeenNthCalledWith(2, true);
  });

  it('replCommandList renders the slash hint, formatReplHelp lists every command', () => {
    expect(replCommandList()).toBe(
      '/models, /mode, /effort, /thinking, /permissions, /trim, /compact, /cost, /details, /agent, /workflows, /doctor, /help, /copy, /export, /edit, /scrollback, /clear, /cancel, /exit',
    );
    const help = formatReplHelp();
    for (const command of REPL_COMMANDS) {
      expect(help).toContain(`/${command.name}`);
      expect(help).toContain(command.description);
    }
  });

  /**
   * `/help` and the unknown-slash hint as a stand-alone chat printed them before the surfaces were told apart (the text at commit b2103932). The
   * plain, `--json` and one-shot drivers print it to standard error, so it is byte for byte what they print now: the default surface is the
   * stand-alone chat's, and naming no surface changes nothing.
   */
  const STAND_ALONE_HELP = `${[
    'Commands:',
    '  /models  Switch model (opens the catalog picker).',
    '  /mode  Choose the mode; Shift+Tab changes this chat only.',
    '  /effort  Set the reasoning-effort tier: off / low / medium / high / max (ADR-0066).',
    '  /thinking  Show or hide the reasoning ("thinking") panel (or [Ctrl+T] to toggle).',
    '  /permissions  Open the permissions sheet: the commands remembered for this project and approved for this session; [d] withdraws one.',
    '  /trim  Deterministically drop older messages (no LLM call); /trim [n], default [chat].max_messages.',
    '  /compact  Summarise the conversation so far to reclaim context (spends tokens).',
    "  /cost  Show this session's cumulative cost; --release clears held estimates.",
    '  /details  Inspect recent tool calls and their available previews.',
    '  /agent  Show the agent this chat is bound to.',
    '  /workflows  List the workflows and agents discovered in this project.',
    '  /doctor  Check your setup; --deep also validates keys and MCP.',
    '  /help  List the available slash commands.',
    '  /copy  Copy the whole transcript to the system clipboard (OSC 52).',
    '  /export  Scaffold the session so far to a .relavium.yaml.',
    '  /edit  Open the transcript in $EDITOR (read-only — to search or copy).',
    '  /scrollback  Dump the transcript into the terminal’s native scrollback (to copy or search).',
    '  /clear  End this conversation (saved + resumable) and start a fresh session.',
    '  /cancel  Cancel the current turn and end the (resumable) session.',
    '  /exit  End the chat session.',
  ].join('\n')}\n`;

  it('a stand-alone chat’s /help and hint are byte for byte what they were, with or without naming the surface', () => {
    expect(formatReplHelp()).toBe(STAND_ALONE_HELP);
    expect(formatReplHelp('chat')).toBe(STAND_ALONE_HELP);
    expect(replCommandList('chat')).toBe(replCommandList());
  });

  it('the chat the Home hosts prints its own list: its palette’s rows, with its words, and /resume', () => {
    const help = formatReplHelp('home-chat');
    const rows = help.split('\n').filter((line) => line.startsWith('  /'));
    // The rows ARE the palette's: the same commands in the same order with the same words, so /help and the palette cannot disagree.
    expect(rows).toEqual(
      HOME_CHAT_PALETTE_COMMANDS.map((command) => `  /${command.name}  ${command.description}`),
    );
    expect(help).toContain('  /exit  Leave this chat and go back to the Home.');
    expect(help).not.toContain('End the chat session.');
    expect(rows.some((row) => row.startsWith('  /resume  '))).toBe(true);
    expect(replCommandList('home-chat')).toBe(
      HOME_CHAT_PALETTE_COMMANDS.map((command) => `/${command.name}`).join(', '),
    );
    expect(replCommandList('home-chat')).toContain('/resume');
    expect(help).not.toBe(STAND_ALONE_HELP);
  });

  it('effects are sound: export + compact write, clear destructive, the rest read', () => {
    expect(REPL_COMMANDS_BY_NAME.get('export')?.effect).toBe('write');
    expect(REPL_COMMANDS_BY_NAME.get('compact')?.effect).toBe('write'); // /compact spends tokens (ADR-0062)
    expect(REPL_COMMANDS_BY_NAME.get('clear')?.effect).toBe('destructive'); // /clear ends the session (ADR-0062 §7)
    for (const name of [
      'help',
      'exit',
      'cancel',
      'agent',
      'workflows',
      'cost',
      'permissions',
      'doctor',
      'mode',
      'effort',
      'thinking',
      'details',
      'trim',
      'models',
      'scrollback',
      'edit',
      'copy',
    ]) {
      expect(REPL_COMMANDS_BY_NAME.get(name)?.effect).toBe('read');
    }
  });

  it('every command declares a non-empty availableIn; the palette sets derive from the one table (with /help, since ADR-0145 §7.3)', () => {
    for (const command of REPL_COMMANDS) {
      expect(command.availableIn.length, `${command.name} availableIn`).toBeGreaterThan(0);
    }
    const chat = [
      'models',
      'mode',
      'effort',
      'thinking',
      'permissions',
      'trim',
      'compact',
      'cost',
      'details',
      'agent',
      'workflows',
      'doctor',
      'help',
      'copy',
      'export',
      'edit',
      'scrollback',
      'clear',
      'cancel',
      'exit',
    ];
    // A stand-alone chat's palette is its REPL list: `/help` is listed now, so the old "everything but /help" set is gone.
    expect(REPL_COMMANDS.map((c) => c.name)).toEqual(chat);
    // The chat the Home hosts: a chat's list with /resume first in *End*, and without /providers and /init (OD-2).
    expect(HOME_CHAT_PALETTE_COMMANDS.map((c) => c.name)).toEqual([
      ...chat.slice(0, chat.indexOf('clear')),
      'resume',
      ...chat.slice(chat.indexOf('clear')),
    ]);
    // The bare Home: Work, Set up, Check, End (the Home's `/exit` leaves Relavium; `/clear` is listed dim, with its reason).
    expect(HOME_PALETTE_COMMANDS.map((c) => c.name)).toEqual([
      'resume',
      'run',
      'workflows',
      'agents',
      'providers',
      'models',
      'mode',
      'permissions',
      'pricing',
      'init',
      'import',
      'doctor',
      'help',
      'clear',
      'exit',
    ]);
  });

  it('/workflows is ONE command with two placements: the chat lists, the bare Home opens the Defined tab, each with its own words', () => {
    const chat = REPL_COMMANDS_BY_NAME.get('workflows');
    expect(chat?.availableIn, 'one definition, placed on both surfaces').toEqual(['home', 'chat']);
    const home = HOME_PALETTE_COMMANDS.find((command) => command.name === 'workflows');
    expect(home?.availableIn).toEqual(['home', 'chat']);
    expect(home?.description).toBe('The workflows of this project: run or export one.');
    expect(chat?.description).toBe('List the workflows and agents discovered in this project.');
    expect(home, 'one object per surface: the Home’s words are the Home’s').not.toBe(chat);
    expect(home?.run).toBe(chat?.run);
    expect(REPL_COMMANDS.filter((c) => c.name === 'workflows')).toEqual([chat]);
    expect(HOME_CHAT_PALETTE_COMMANDS.filter((c) => c.name === 'workflows')).toEqual([chat]);
    expect(HOME_PALETTE_COMMANDS.filter((c) => c.name === 'workflows')).toEqual([home]);
  });

  it('/run is a Home command only: it is in the Home palette and in no chat palette (ADR-0139 §7)', () => {
    const run = HOME_PALETTE_COMMANDS.find((command) => command.name === 'run');
    expect(run?.availableIn).toEqual(['home']);
    for (const [name, set] of [
      ['CHAT', REPL_COMMANDS],
      ['HOME_CHAT', HOME_CHAT_PALETTE_COMMANDS],
    ] as const) {
      expect(
        set.map((command) => command.name),
        `${name} must not offer /run`,
      ).not.toContain('run');
    }
    // Nor is it a REPL command a chat could dispatch: a typed `/run` in a chat is an unknown slash.
    expect(REPL_COMMANDS_BY_NAME.has('run')).toBe(false);
  });

  it('/import and /pricing are Home commands only: in the Home palette, in no chat palette, and not a command a chat could dispatch (ADR-0140 §9)', () => {
    for (const name of ['import', 'pricing']) {
      const command = HOME_PALETTE_COMMANDS.find((entry) => entry.name === name);
      expect(command?.availableIn, `/${name}`).toEqual(['home']);
      // Both write something (a file, a price) and ask first: the registry says `write`, as it does of `/run` and `/init`.
      expect(command?.effect, `/${name}`).toBe('write');
      for (const [setName, set] of [
        ['CHAT', REPL_COMMANDS],
        ['HOME_CHAT', HOME_CHAT_PALETTE_COMMANDS],
      ] as const) {
        expect(
          set.map((entry) => entry.name),
          `${setName} must not offer /${name}`,
        ).not.toContain(name);
      }
      expect(REPL_COMMANDS_BY_NAME.has(name), `/${name} is no REPL command`).toBe(false);
    }
    expect(
      HOME_PALETTE_COMMANDS.find((command) => command.name === 'pricing')?.description,
      'a row inside the TUI names no shell command (ADR-0122 §6)',
    ).toBe('Set or clear your own price for a model.');
  });

  it('every command of the Home palette is the first answer to its own name, so a description never captures another command’s word', () => {
    // The palette filter matches names AND descriptions. `/pricing`'s words include `clear` and `models`, and `/import`'s include `file` and
    // `project`; none of them may put a command in front of the one a person named, whatever the query.
    const rows = buildPaletteEntries('home', {
      hasSession: false,
      hasKey: true,
      hasSavedSessions: true,
    });
    for (const command of HOME_PALETTE_COMMANDS) {
      const first = filterPaletteEntries(rows, command.name)[0];
      expect(first?.command.name, `the query "${command.name}"`).toBe(command.name);
    }
  });

  it('lists every command once in each palette: the Home’s own /permissions is not also in the chat set (ADR-0137 §3)', () => {
    for (const [name, set] of [
      ['CHAT', REPL_COMMANDS],
      ['HOME', HOME_PALETTE_COMMANDS],
      ['HOME_CHAT', HOME_CHAT_PALETTE_COMMANDS],
    ] as const) {
      const names = set.map((command) => command.name);
      expect(new Set(names).size, `${name}: ${names.join(', ')}`).toBe(names.length);
    }
    expect(HOME_CHAT_PALETTE_COMMANDS.filter((c) => c.name === 'permissions')).toHaveLength(1);
    // One definition on both surfaces now (ADR-0145 §7), so the command says it is offered on the Home and in a chat.
    expect(HOME_CHAT_PALETTE_COMMANDS.find((c) => c.name === 'permissions')?.availableIn).toEqual([
      'home',
      'chat',
    ]);
  });
});
