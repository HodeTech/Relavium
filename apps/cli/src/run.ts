import { CommanderError } from 'commander';

import { executeLazyCommand } from './commands/lazy-dispatch.js';
import type { HomeDeps } from './home/drive-home.js';
import { shouldOpenHome } from './home/should-open-home.js';
import { CLI_ERROR_POLICY, CliError, projectCliError } from './process/cli-error.js';
import { EXIT_CODES, type ExitCode } from './process/exit-codes.js';
import type { CliIo } from './process/io.js';
import { createCliInvocation, type CliInvocation } from './process/invocation.js';
import type { NativeInvocation } from './process/native-invocation.js';
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
    throw new CliError('cli_internal', '', { cause });
  }
  if (deps.invocation?.registry.termination !== undefined) return EXIT_CODES.success;
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
  native?: Pick<NativeInvocation, 'fail'>,
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
    return renderFailure(err, renderCtx, io, native);
  }
  const result: { exitCode?: ExitCode } = {};
  const stopped = new Error('CLI preparation stopped.');
  Object.freeze(stopped);
  const assertPreparing = (): void => {
    if (invocation.registry.termination !== undefined) throw stopped;
  };
  try {
    assertPreparing();
    const program = buildProgram(io, {
      suppressErrorOutput: renderCtx.json,
      context: { io, global, result, invocation },
      execute: async (id, input, ctx) => {
        const admitted = await admitGlobal(ctx.global, assertPreparing);
        assertPreparing();
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
      const admitted = await admitGlobal(global, assertPreparing);
      await invocation.seedFileCatalogOnce();
      assertPreparing();
      return await openHome({ io, global: admitted, invocation });
    }
    await program.parseAsync([...rest]);
    return result.exitCode ?? EXIT_CODES.success;
  } catch (err) {
    if (err === stopped) return EXIT_CODES.success;
    if (err instanceof CommanderError) {
      if (err.exitCode !== 0 && renderCtx.json)
        renderKnownError(
          new CliError('invalid_invocation', stripErrorPrefix(err.message)),
          renderCtx,
          io,
        );
      return err.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.invalidInvocation;
    }
    return renderFailure(err, renderCtx, io, native);
  }
}

async function admitGlobal(
  global: GlobalOptions,
  assertPreparing: () => void,
): Promise<GlobalOptions> {
  assertPreparing();
  let runtime: typeof import('./engine/tool-host/fs-invocation-admission.js');
  try {
    runtime = await import('./engine/tool-host/fs-invocation-admission.js');
  } catch (cause) {
    throw new CliError('cli_internal', '', { cause });
  }
  assertPreparing();
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

function renderFailure(
  value: unknown,
  opts: { json: boolean; verbose: boolean },
  io: CliIo,
  native?: Pick<NativeInvocation, 'fail'>,
): ExitCode {
  const facing = projectCliError(value) ?? projectCliError(new CliError('cli_internal', ''));
  if (facing === undefined) return EXIT_CODES.infrastructureFailed;
  if (facing.code === 'cli_internal' || facing.code === 'output_unavailable') {
    if (native !== undefined) {
      native.fail(facing.code); // Observe before joins; the native owner presents after terminal restoration.
      return EXIT_CODES.infrastructureFailed;
    }
    // Pure embeddings have no native shutdown authority and still receive a fixed content-free diagnostic.
    renderUserFacing(facing, undefined, { ...opts, verbose: false }, io);
  } else {
    renderUserFacing(facing, value, opts, io);
  }
  return facing.exitCode;
}

function isBareInvocation(rest: readonly string[]): boolean {
  return !rest.slice(2).some((token) => token !== '--');
}

function stripErrorPrefix(message: string): string {
  const prefix = 'error:';
  return message.startsWith(prefix) ? message.slice(prefix.length).trimStart() : message;
}
