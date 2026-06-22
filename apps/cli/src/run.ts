import { CommanderError } from 'commander';

import { CliError, toUserFacing } from './process/errors.js';
import { EXIT_CODES, type ExitCode } from './process/exit-codes.js';
import type { CliIo } from './process/io.js';
import {
  extractGlobalOptions,
  resolveGlobalOptions,
  type GlobalOptions,
} from './process/options.js';
import { renderError } from './process/render-error.js';
import { buildProgram } from './program.js';

/**
 * The CLI's top-level boundary: extract the position-independent global flags, resolve them, build the
 * program with the command runtime context, parse the remaining argv (node-style), and translate every
 * outcome to a single deterministic exit code ([commands.md](../../../docs/reference/cli/commands.md#exit-codes)).
 * A command's exit code is set on the shared `result` holder; pre-parse and parse faults are rendered
 * here. Designed to **never reject**.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const { raw, rest, error: extractError } = extractGlobalOptions(argv);
  // `raw` is fully populated by extraction (it never throws), so the render honors any
  // `--json`/`--verbose` even when a later global flag is the thing that failed.
  const renderCtx = { json: raw.json === true, verbose: raw.verbose === true };

  if (extractError !== undefined) {
    renderError(extractError, renderCtx, io);
    return extractError.exitCode;
  }

  let global: GlobalOptions;
  try {
    global = resolveGlobalOptions(raw, process.cwd()); // also enforces the --verbose/--quiet rule
  } catch (err) {
    renderError(err, renderCtx, io);
    return toUserFacing(err).exitCode;
  }

  const result: { exitCode?: ExitCode } = {};
  const program = buildProgram(io, {
    suppressErrorOutput: renderCtx.json,
    context: { io, global, result },
  });

  // Bare invocation — no subcommand after extraction (only `[node, script]`, optionally a lone `--`):
  // print help and exit 0 rather than letting commander error.
  if (!rest.slice(2).some((token) => token !== '--')) {
    io.writeOut(program.helpInformation());
    return EXIT_CODES.success;
  }

  try {
    await program.parseAsync([...rest]);
    return result.exitCode ?? EXIT_CODES.success;
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander wrote help/version to stdout; under --json its stderr was suppressed, so emit the
      // structured envelope ourselves. `exitCode` is 0 for help/version, non-zero for a parse fault → 2.
      if (err.exitCode !== 0 && renderCtx.json) {
        renderError(
          new CliError('invalid_invocation', stripErrorPrefix(err.message)),
          renderCtx,
          io,
        );
      }
      return err.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.invalidInvocation;
    }
    // A CliError thrown by a command action, or an unexpected throw.
    renderError(err, renderCtx, io);
    return toUserFacing(err).exitCode;
  }
}

/** Drop commander's redundant leading `error:` prefix (the JSON envelope already says type:error). */
function stripErrorPrefix(message: string): string {
  const prefix = 'error:';
  if (!message.startsWith(prefix)) {
    return message;
  }
  return message.slice(prefix.length).trimStart();
}
