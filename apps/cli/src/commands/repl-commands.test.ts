import { describe, expect, it, vi } from 'vitest';

import {
  CHAT_PALETTE_COMMANDS,
  formatReplHelp,
  HOME_PALETTE_COMMANDS,
  PALETTE_COMMANDS,
  replCommandList,
  REPL_COMMANDS,
  REPL_COMMANDS_BY_NAME,
  type ReplCommandContext,
} from './repl-commands.js';

interface CapabilityCalls {
  readonly exit: number;
  readonly cancel: number;
  readonly exportSession: number;
  readonly help: number;
  readonly showWorkflows: number;
  readonly showCost: number;
  readonly runDoctor: number;
  readonly setMode: number;
}

/** A fully-spied REPL context — each capability is a spy so a command's `run` can be asserted to call exactly one. */
function spyContext(): { ctx: ReplCommandContext; calls: () => CapabilityCalls } {
  const spies = {
    exit: vi.fn(),
    cancel: vi.fn(),
    exportSession: vi.fn(),
    help: vi.fn(),
    showWorkflows: vi.fn(),
    showCost: vi.fn(),
    runDoctor: vi.fn(),
    setMode: vi.fn(),
  };
  return {
    ctx: spies,
    calls: () => ({
      exit: spies.exit.mock.calls.length,
      cancel: spies.cancel.mock.calls.length,
      exportSession: spies.exportSession.mock.calls.length,
      help: spies.help.mock.calls.length,
      showWorkflows: spies.showWorkflows.mock.calls.length,
      showCost: spies.showCost.mock.calls.length,
      setMode: spies.setMode.mock.calls.length,
      runDoctor: spies.runDoctor.mock.calls.length,
    }),
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
      'workflows',
      'cost',
      'doctor',
      'mode',
    ]);
  });

  it('each command run() invokes EXACTLY its one capability', async () => {
    const cases: Array<[string, keyof ReturnType<ReturnType<typeof spyContext>['calls']>]> = [
      ['help', 'help'],
      ['exit', 'exit'],
      ['cancel', 'cancel'],
      ['export', 'exportSession'],
      ['workflows', 'showWorkflows'],
      ['cost', 'showCost'],
      ['doctor', 'runDoctor'],
      ['mode', 'setMode'],
    ];
    for (const [name, capability] of cases) {
      const { ctx, calls } = spyContext();
      await REPL_COMMANDS_BY_NAME.get(name)?.run(ctx, []); // run may be async — await so the spy is recorded (+ no unhandled rejection)
      const counts = calls();
      expect(counts[capability], `${name} → ${capability}`).toBe(1);
      const total =
        counts.exit +
        counts.cancel +
        counts.exportSession +
        counts.help +
        counts.showWorkflows +
        counts.showCost +
        counts.runDoctor +
        counts.setMode;
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
      '/help, /exit, /cancel, /export, /workflows, /cost, /doctor, /mode',
    );
    const help = formatReplHelp();
    for (const command of REPL_COMMANDS) {
      expect(help).toContain(`/${command.name}`);
      expect(help).toContain(command.description);
    }
  });

  it('effects are sound: export writes, the rest are read', () => {
    expect(REPL_COMMANDS_BY_NAME.get('export')?.effect).toBe('write');
    for (const name of ['help', 'exit', 'cancel', 'workflows', 'cost', 'doctor', 'mode']) {
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
      'workflows',
      'cost',
      'doctor',
      'mode',
    ]);
    expect(CHAT_PALETTE_COMMANDS.map((c) => c.name)).toEqual([
      'exit',
      'cancel',
      'export',
      'workflows',
      'cost',
      'doctor',
      'mode',
    ]);
    // The bare Home now offers /exit + /doctor (pre-chat diagnostics — a real Home capability via homeReplCtx).
    expect(HOME_PALETTE_COMMANDS.map((c) => c.name)).toEqual(['exit', 'doctor']);
  });
});
