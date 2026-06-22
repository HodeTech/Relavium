import { CommanderError } from 'commander';

import { toUserFacing } from './process/errors.js';
import { EXIT_CODES, type ExitCode } from './process/exit-codes.js';
import type { CliIo } from './process/io.js';
import { assertNoGlobalOptionConflicts, extractGlobalOptions } from './process/options.js';
import { renderError } from './process/render-error.js';
import { buildProgram } from './program.js';

/**
 * The CLI's top-level boundary: extract the position-independent global flags, then build the
 * program, parse the remaining argv (node-style — includes the leading `node` + script
 * entries), and translate every outcome to a single deterministic exit code
 * ([commands.md](../../../docs/reference/cli/commands.md#exit-codes)). Designed to **never
 * reject** — a thrown error becomes a rendered error plus an exit code.
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
  try {
    assertNoGlobalOptionConflicts(raw);
  } catch (err) {
    renderError(err, renderCtx, io);
    return toUserFacing(err).exitCode;
  }

  const program = buildProgram(io); // `exitOverride` is set inside, before subcommands.

  // Bare invocation — no subcommand after global extraction (only the `[node, script]` prefix,
  // optionally a lone `--`): print help and exit 0 rather than letting commander error.
  if (!rest.slice(2).some((token) => token !== '--')) {
    io.writeOut(program.helpInformation());
    return EXIT_CODES.success;
  }

  try {
    await program.parseAsync([...rest]);
    return EXIT_CODES.success;
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander already wrote help/version to stdout, or its parse error to stderr; its
      // own `exitCode` is `0` for help/version and non-zero for a parse fault → our `2`.
      return err.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.invalidInvocation;
    }
    // A CliError thrown by a command action, or an unexpected throw.
    renderError(err, renderCtx, io);
    return toUserFacing(err).exitCode;
  }
}
