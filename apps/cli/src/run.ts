import { CommanderError } from 'commander';

import { toUserFacing } from './process/errors.js';
import { EXIT_CODES, type ExitCode } from './process/exit-codes.js';
import type { CliIo } from './process/io.js';
import {
  assertNoGlobalOptionConflicts,
  extractGlobalOptions,
  type RawGlobalOptions,
} from './process/options.js';
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
  let raw: RawGlobalOptions = {};
  let rest: readonly string[];
  try {
    const extracted = extractGlobalOptions(argv);
    raw = extracted.raw;
    rest = extracted.rest;
    assertNoGlobalOptionConflicts(raw);
  } catch (err) {
    renderError(err, { json: raw.json === true, verbose: raw.verbose === true }, io);
    return toUserFacing(err).exitCode;
  }

  const program = buildProgram(io); // `exitOverride` is set inside, before subcommands.

  // Bare invocation (no subcommand, only `[node, script]` after global extraction): print
  // help and exit 0, rather than letting commander succeed silently.
  if (rest.length <= 2) {
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
    renderError(err, { json: raw.json === true, verbose: raw.verbose === true }, io);
    return toUserFacing(err).exitCode;
  }
}
