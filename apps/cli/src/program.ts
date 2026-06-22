import { Command } from 'commander';

import { registerCommands } from './commands/specs.js';
import type { CliIo } from './process/io.js';

/** CLI version — a constant for now; wired to `package.json` during packaging (workstream 2.L). */
export const CLI_VERSION = '0.0.0';

/**
 * The position-independent global flags are owned by `extractGlobalOptions` (options.ts), not
 * by `commander`, so they are documented here as help text rather than parsed options.
 */
const GLOBAL_OPTIONS_HELP = `
Global options (usable anywhere on the command line):
  --json            emit machine-readable NDJSON output (disables the TUI)
  --no-color        disable colored output
  --cwd <dir>       run as if started in <dir>
  --config <path>   use an explicit config file
  -v, --verbose     print verbose diagnostics to stderr
  -q, --quiet       suppress non-essential output`;

/**
 * Build the `commander` program: the full subcommand surface plus a bare-invocation help
 * action. All output is routed through the injected `CliIo` so the program is testable with
 * no real stdout/TTY. Global flags are extracted upstream (run.ts) and never reach here.
 */
export function buildProgram(
  io: CliIo,
  options?: { readonly suppressErrorOutput?: boolean },
): Command {
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
        // stdout, so commander's own human stderr message is suppressed to avoid a double.
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
  registerCommands(program);
  return program;
}
