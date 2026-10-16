import type { ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';

export type CommandOptionValue = string | boolean | readonly string[] | undefined;

export interface CommandInput {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, CommandOptionValue>>;
}

export interface DispatchContext {
  readonly io: CliIo;
  readonly global: GlobalOptions;
}

export type CommandExecutor = (input: CommandInput, ctx: DispatchContext) => Promise<ExitCode>;
export type DispatchCommand = (
  id: string,
  input: CommandInput,
  ctx: DispatchContext,
) => Promise<ExitCode>;
