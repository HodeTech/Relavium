import { describe, expect, it, vi } from 'vitest';

import {
  CHAT_PALETTE_COMMANDS,
  formatReplHelp,
  HOME_PALETTE_COMMANDS,
  HOME_CHAT_PALETTE_COMMANDS,
  PALETTE_COMMANDS,
  replCommandList,
  REPL_COMMANDS,
  REPL_COMMANDS_BY_NAME,
  type ReplCommandContext,
} from './repl-commands.js';

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
    expect(names).toEqual([
      'help',
      'exit',
      'cancel',
      'export',
      'agent',
      'workflows',
      'cost',
      'doctor',
      'mode',
      'effort',
      'thinking',
      'details',
      'compact',
      'permissions',
      'trim',
      'clear',
      'models',
      'scrollback',
      'edit',
      'copy',
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
    expect(command?.rejectHint).toBe('Open /permissions and press d on a row to withdraw it.');
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
      ['CHAT', CHAT_PALETTE_COMMANDS],
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
      '/help, /exit, /cancel, /export, /agent, /workflows, /cost, /doctor, /mode, /effort, /thinking, /details, /compact, /permissions, /trim, /clear, /models, /scrollback, /edit, /copy',
    );
    const help = formatReplHelp();
    for (const command of REPL_COMMANDS) {
      expect(help).toContain(`/${command.name}`);
      expect(help).toContain(command.description);
    }
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

  it('every command declares a non-empty availableIn; the palette sets derive from it (no /help)', () => {
    for (const command of REPL_COMMANDS) {
      expect(command.availableIn.length, `${command.name} availableIn`).toBeGreaterThan(0);
    }
    // The base palette set excludes /help; the surface sets split it by availableIn.
    expect(PALETTE_COMMANDS.map((c) => c.name)).toEqual([
      'exit',
      'cancel',
      'export',
      'agent',
      'workflows',
      'cost',
      'doctor',
      'mode',
      'effort',
      'thinking',
      'details',
      'compact',
      'permissions',
      'trim',
      'clear',
      'models',
      'scrollback',
      'edit',
      'copy',
    ]);
    // /models is availableIn ['home','chat'] (ADR-0059: the chat reseat) — so it appears in BOTH palettes.
    expect(CHAT_PALETTE_COMMANDS.map((c) => c.name)).toEqual([
      'exit',
      'cancel',
      'export',
      'agent',
      'workflows',
      'cost',
      'doctor',
      'mode',
      'effort',
      'thinking',
      'details',
      'compact',
      'permissions',
      'trim',
      'clear',
      'models',
      'scrollback',
      'edit',
      'copy',
    ]);
    // The bare Home offers /exit + /doctor (pre-chat diagnostics), /clear (availableIn ['home','chat']; an inert
    // "nothing to clear" notice — ADR-0062 §7), and /models (availableIn ['home','chat'] — the Home writes the
    // next-session default, ADR-0064 §10; the chat reseats live, ADR-0059).
    expect(HOME_PALETTE_COMMANDS.map((c) => c.name)).toEqual([
      'exit',
      'doctor',
      'mode',
      'clear',
      'models',
      'providers',
      'init',
      'permissions', // the bare Home's sheet of the project's remembered commands (ADR-0137 §3)
      'resume',
      'run', // the launch of a hosted workflow run (ADR-0139 §7, MVP-8 step 3)
      'workflows', // the Defined tab of the tab host (ADR-0140 §2, MVP-8 step 4): the Home's own, not the chat's
      'agents', // the `/agents` strip of the tab host (ADR-0140 §3, MVP-8 step 5): the Home's own, there is no chat `/agents`
    ]);
  });

  it('/workflows is two commands: the chat lists, the bare Home opens the Defined tab, and neither palette carries the other', () => {
    const chat = REPL_COMMANDS_BY_NAME.get('workflows');
    expect(chat?.availableIn, 'the chat’s own command is unchanged').toEqual(['chat']);
    const home = HOME_PALETTE_COMMANDS.find((command) => command.name === 'workflows');
    expect(home?.availableIn).toEqual(['home']);
    expect(home, 'a distinct entry, not the chat’s').not.toBe(chat);
    expect(CHAT_PALETTE_COMMANDS.filter((c) => c.name === 'workflows')).toEqual([chat]);
    expect(HOME_CHAT_PALETTE_COMMANDS.filter((c) => c.name === 'workflows')).toEqual([chat]);
    expect(HOME_PALETTE_COMMANDS.filter((c) => c.name === 'workflows')).toEqual([home]);
  });

  it('/run is a Home command only: it is in the Home palette and in no chat palette (ADR-0139 §7)', () => {
    const run = HOME_PALETTE_COMMANDS.find((command) => command.name === 'run');
    expect(run?.availableIn).toEqual(['home']);
    for (const [name, set] of [
      ['PALETTE', PALETTE_COMMANDS],
      ['CHAT', CHAT_PALETTE_COMMANDS],
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

  it('lists every command once in each palette: the Home’s own /permissions is not also in the chat set (ADR-0137 §3)', () => {
    for (const [name, set] of [
      ['PALETTE', PALETTE_COMMANDS],
      ['CHAT', CHAT_PALETTE_COMMANDS],
      ['HOME', HOME_PALETTE_COMMANDS],
      ['HOME_CHAT', HOME_CHAT_PALETTE_COMMANDS],
    ] as const) {
      const names = set.map((command) => command.name);
      expect(new Set(names).size, `${name}: ${names.join(', ')}`).toBe(names.length);
    }
    expect(HOME_CHAT_PALETTE_COMMANDS.filter((c) => c.name === 'permissions')).toHaveLength(1);
    expect(HOME_CHAT_PALETTE_COMMANDS.find((c) => c.name === 'permissions')?.availableIn).toEqual([
      'chat',
    ]);
  });
});
