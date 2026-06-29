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
}

/** A fully-spied REPL context — each capability is a spy so a command's `run` can be asserted to call exactly one. */
function spyContext(): { ctx: ReplCommandContext; calls: () => CapabilityCalls } {
  const spies = {
    exit: vi.fn(),
    cancel: vi.fn(),
    exportSession: vi.fn(),
    help: vi.fn(),
  };
  return {
    ctx: spies,
    calls: () => ({
      exit: spies.exit.mock.calls.length,
      cancel: spies.cancel.mock.calls.length,
      exportSession: spies.exportSession.mock.calls.length,
      help: spies.help.mock.calls.length,
    }),
  };
}

describe('curated REPL command registry (ADR-0056 amendment)', () => {
  it('has a small, alias-free set with unique names', () => {
    const names = REPL_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(REPL_COMMANDS_BY_NAME.size).toBe(names.length);
    expect(names).toEqual(['help', 'exit', 'cancel', 'export']);
  });

  it('each command run() invokes EXACTLY its one capability', () => {
    const cases: Array<[string, keyof ReturnType<ReturnType<typeof spyContext>['calls']>]> = [
      ['help', 'help'],
      ['exit', 'exit'],
      ['cancel', 'cancel'],
      ['export', 'exportSession'],
    ];
    for (const [name, capability] of cases) {
      const { ctx, calls } = spyContext();
      void REPL_COMMANDS_BY_NAME.get(name)?.run(ctx); // run may be async (widened); the spies record synchronously
      const counts = calls();
      expect(counts[capability], `${name} → ${capability}`).toBe(1);
      const total = counts.exit + counts.cancel + counts.exportSession + counts.help;
      expect(total, `${name} calls exactly one capability`).toBe(1);
    }
  });

  it('replCommandList renders the slash hint, formatReplHelp lists every command', () => {
    expect(replCommandList()).toBe('/help, /exit, /cancel, /export');
    const help = formatReplHelp();
    for (const command of REPL_COMMANDS) {
      expect(help).toContain(`/${command.name}`);
      expect(help).toContain(command.description);
    }
  });

  it('effects are sound: export writes, the rest are read', () => {
    expect(REPL_COMMANDS_BY_NAME.get('export')?.effect).toBe('write');
    for (const name of ['help', 'exit', 'cancel']) {
      expect(REPL_COMMANDS_BY_NAME.get(name)?.effect).toBe('read');
    }
  });

  it('every command declares a non-empty availableIn; the palette sets derive from it (no /help)', () => {
    for (const command of REPL_COMMANDS) {
      expect(command.availableIn.length, `${command.name} availableIn`).toBeGreaterThan(0);
    }
    // The base palette set excludes /help; the surface sets split it by availableIn.
    expect(PALETTE_COMMANDS.map((c) => c.name)).toEqual(['exit', 'cancel', 'export']);
    expect(CHAT_PALETTE_COMMANDS.map((c) => c.name)).toEqual(['exit', 'cancel', 'export']);
    expect(HOME_PALETTE_COMMANDS.map((c) => c.name)).toEqual(['exit']); // only /exit applies in the bare Home today
  });
});
