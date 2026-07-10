import { Command } from 'commander';

import { registerCommands, type CommandContext } from './commands/specs.js';
import type { CliIo } from './process/io.js';

export interface BuildProgramOptions {
  /** Suppress commander's human stderr so the boundary can re-render parse errors as JSON (--json). */
  readonly suppressErrorOutput?: boolean;
  /** The runtime context the real commands need; absent ⇒ commands stay help-only stubs. */
  readonly context?: CommandContext;
}

/**
 * CLI version. `tsup` replaces `__RELAVIUM_CLI_VERSION__` with the `package.json` version at build time
 * (see tsup.config.ts `define`); a source run (tsx/vitest — no define) falls back to a dev sentinel, since an
 * unbundled process has no published version. `typeof` keeps the source path from a ReferenceError. (2.L, ADR-0051.)
 */
declare const __RELAVIUM_CLI_VERSION__: string | undefined;
export const CLI_VERSION =
  typeof __RELAVIUM_CLI_VERSION__ === 'string' ? __RELAVIUM_CLI_VERSION__ : '0.0.0-dev';

/**
 * The position-independent global flags are owned by `extractGlobalOptions` (options.ts), not
 * by `commander`, so they are documented here as help text rather than parsed options.
 */
const GLOBAL_OPTIONS_HELP = `
Global options (usable anywhere on the command line):
  --json            emit machine-readable NDJSON output (disables the TUI)
  --color           force colored output on
  --no-color        disable colored output
  --cwd <dir>       run as if started in <dir>
  --config <path>   use an explicit config file
  --no-alt-screen   keep the inline renderer (no full-screen alt screen)
  --no-mouse        disable mouse reporting (restores native click-drag selection)
  -v, --verbose     print verbose diagnostics to stderr
  -q, --quiet       suppress non-essential output

Color precedence: --color/--no-color > NO_COLOR (any value ⇒ off) > FORCE_COLOR (0/false ⇒ off) > on.`;

/**
 * Build the `commander` program: the full subcommand surface plus a bare-invocation help
 * action. All output is routed through the injected `CliIo` so the program is testable with
 * no real stdout/TTY. Global flags are extracted upstream (run.ts) and never reach here.
 */
export function buildProgram(io: CliIo, options?: BuildProgramOptions): Command {
  const program = new Command();
  program
    .name('relavium')
    .description('Relavium — run agent workflows from the terminal.')
    .version(CLI_VERSION, '-V, --version', 'output the version number')
    .configureOutput({
      writeOut: (str) => {
        io.writeOut(str);
      },
      writeErr: (str) => {
        // Under --json the caller re-renders commander's parse errors as a JSON envelope on
        // stderr (ADR-0049), so commander's own human stderr message is suppressed to avoid a double.
        if (options?.suppressErrorOutput !== true) {
          io.writeErr(str);
        }
      },
    })
    .addHelpText('after', GLOBAL_OPTIONS_HELP);

  // Throw a `CommanderError` instead of calling `process.exit` on a parse fault, help, or
  // version — so run.ts maps every outcome to a deterministic exit code. MUST be set BEFORE
  // `registerCommands`: commander copies `_exitCallback` to each subcommand at creation, so a
  // later call would leave subcommands (e.g. a missing-argument on `run`) calling process.exit.
  program.exitOverride();

  // NB: no `program.action()` — a default action would make `commander` treat an unknown
  // subcommand as a positional argument (swallowing the unknown-command error). The bare
  // invocation (no subcommand) is handled in run.ts, which prints help and exits 0.
  registerCommands(program, options?.context);
  return program;
}
