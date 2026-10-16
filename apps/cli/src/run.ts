import { CommanderError } from 'commander';

import { executeLazyCommand } from './commands/lazy-dispatch.js';
import type { HomeDeps } from './home/drive-home.js';
import { shouldOpenHome } from './home/should-open-home.js';
import {
  CLI_ERROR_POLICY,
  CliError,
  isCliError,
  type UserFacingError,
} from './process/cli-error.js';
import { EXIT_CODES, type ExitCode } from './process/exit-codes.js';
import type { CliIo } from './process/io.js';
import { createCliInvocation, type CliInvocation } from './process/invocation.js';
import {
  extractGlobalOptions,
  resolveGlobalOptions,
  type GlobalOptions,
} from './process/options.js';
import { renderUserFacing } from './process/render-user-facing.js';
import { buildProgram } from './program.js';

/** Injectable Home boundary; the production implementation is imported only after admission. */
export type OpenHome = (deps: HomeDeps) => Promise<ExitCode>;

const openLazyHome: OpenHome = async (deps) => {
  let runtime: typeof import('./home/drive-home.js');
  try {
    runtime = await import('./home/drive-home.js');
  } catch (cause) {
    throw new CliError('internal', 'The CLI runtime could not be loaded.', { cause });
  }
  return runtime.driveHome(deps);
};

/**
 * One grammar for meta and real execution. Only an actual action or interactive Home
 * admits directories, seeds a needed offline catalog and enters the lazy runtime.
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
  openHome: OpenHome = openLazyHome,
  invocation: CliInvocation = createCliInvocation(),
): Promise<ExitCode> {
  const { raw, rest, error: extractError } = extractGlobalOptions(argv);
  const renderCtx = { json: raw.json === true, verbose: raw.verbose === true };
  if (extractError !== undefined) {
    renderKnownError(extractError, renderCtx, io);
    return extractError.exitCode;
  }

  let global: GlobalOptions;
  try {
    global = resolveGlobalOptions(raw, process.cwd(), io.env);
  } catch (err) {
    return renderFailure(err, renderCtx, io);
  }
  const result: { exitCode?: ExitCode } = {};
  try {
    const program = buildProgram(io, {
      suppressErrorOutput: renderCtx.json,
      context: { io, global, result, invocation },
      execute: async (id, input, ctx) => {
        const admitted = await admitGlobal(ctx.global);
        return executeLazyCommand(id, input, { ...ctx, global: admitted });
      },
    });
    if (isBareInvocation(rest)) {
      if (
        !shouldOpenHome({
          stdoutIsTty: io.stdoutIsTty,
          stdinIsTty: io.stdinIsTty,
          json: global.json,
          env: io.env,
        })
      ) {
        io.writeOut(program.helpInformation());
        return EXIT_CODES.success;
      }
      const admitted = await admitGlobal(global);
      await invocation.seedFileCatalogOnce();
      return await openHome({ io, global: admitted, invocation });
    }
    await program.parseAsync([...rest]);
    return result.exitCode ?? EXIT_CODES.success;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode !== 0 && renderCtx.json)
        renderKnownError(
          new CliError('invalid_invocation', stripErrorPrefix(err.message)),
          renderCtx,
          io,
        );
      return err.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.invalidInvocation;
    }
    return renderFailure(err, renderCtx, io);
  }
}

async function admitGlobal(global: GlobalOptions): Promise<GlobalOptions> {
  let runtime: typeof import('./engine/tool-host/fs-invocation-admission.js');
  try {
    runtime = await import('./engine/tool-host/fs-invocation-admission.js');
  } catch (cause) {
    throw new CliError('internal', 'The CLI runtime could not be loaded.', { cause });
  }
  return Object.freeze({ ...global, fsGrants: runtime.admitFsInvocation(global) });
}

function renderKnownError(
  error: CliError,
  opts: { json: boolean; verbose: boolean },
  io: CliIo,
): void {
  renderUserFacing(
    {
      code: error.code,
      message: CLI_ERROR_POLICY[error.code].fixedMessage ?? error.message,
      exitCode: error.exitCode,
    },
    error,
    opts,
    io,
  );
}

async function renderFailure(
  value: unknown,
  opts: { json: boolean; verbose: boolean },
  io: CliIo,
): Promise<ExitCode> {
  if (isCliError(value)) {
    renderKnownError(value, opts, io);
    return value.exitCode;
  }
  let facing: UserFacingError;
  try {
    const { toUserFacing } = await import('./process/errors.js');
    facing = toUserFacing(value);
  } catch {
    // Classification may itself be unavailable after a dependency import failure.
    const fixed = new CliError('internal', 'An unexpected internal error occurred.');
    renderKnownError(fixed, opts, io);
    return fixed.exitCode;
  }
  renderUserFacing(facing, value, opts, io);
  return facing.exitCode;
}

function isBareInvocation(rest: readonly string[]): boolean {
  return !rest.slice(2).some((token) => token !== '--');
}

function stripErrorPrefix(message: string): string {
  const prefix = 'error:';
  return message.startsWith(prefix) ? message.slice(prefix.length).trimStart() : message;
}
