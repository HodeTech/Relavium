import { Command } from 'commander';

import { registerCommands, type CommandContext } from './commands/specs.js';
import { GLOBAL_OPTION_DESCRIPTORS } from './commands/descriptors.js';
import type { DispatchCommand } from './commands/input.js';
import type { CliIo } from './process/io.js';

export interface BuildProgramOptions {
  /** Suppress commander's human stderr so the boundary can re-render parse errors as JSON (--json). */
  readonly suppressErrorOutput?: boolean;
  /** The runtime context the real commands need; absent ⇒ commands stay help-only stubs. */
  readonly context?: CommandContext;
  /** Inject runtime dispatch; constructing grammar never imports or starts services. */
  readonly execute?: DispatchCommand;
}

import { CLI_VERSION } from './version.js';
export { CLI_VERSION } from './version.js';

/**
 * The position-independent global flags are owned by `extractGlobalOptions` (options.ts), not
 * by `commander`, so they are documented here as help text rather than parsed options.
 */
const GLOBAL_OPTIONS_HELP = `
Global options (usable anywhere on the command line):
${GLOBAL_OPTION_DESCRIPTORS.filter((option) => option.owner === 'extractor')
  .map((option) => {
    const name =
      option.spellings.join(', ') +
      (option.arity === 'none' ? '' : ` <${option.placeholder ?? 'value'}>`);
    return `  ${name.padEnd(Math.max(18, name.length + 2))}${option.description}`;
  })
  .join('\n')}

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
  registerCommands(program, options?.context, options?.execute);
  return program;
}
