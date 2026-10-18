import { CommanderError, Option, type Command } from 'commander';

import { CliError } from '../process/cli-error.js';
import type { ExitCode } from '../process/exit-codes.js';
import {
  COMMAND_DESCRIPTORS,
  compatibilityOptions,
  compatibilityPath,
  type CommandDescriptor,
  type OptionDescriptor,
} from './descriptors.js';
import type { CommandOptionValue, DispatchCommand, DispatchContext } from './input.js';

export interface CommandContext extends DispatchContext {
  readonly result: { exitCode?: ExitCode };
}

/** Availability derives from the descriptor authority, not a separately authored stub list. */
export const STUB_COMMANDS = Object.freeze(
  COMMAND_DESCRIPTORS.filter((entry) => entry.availability === 'not_implemented').map((entry) =>
    Object.freeze({
      name: entry.path.join(' '),
      summary: entry.description,
      landsIn: entry.landsIn ?? 'a later workstream',
    }),
  ),
);

function flags(option: OptionDescriptor): string {
  const base = option.spellings.join(', ');
  if (option.arity === 'none') return base;
  const value = `${option.placeholder ?? 'value'}${option.repetition === 'variadic' ? '...' : ''}`;
  return `${base} ${option.arity === 'required' ? `<${value}>` : `[${value}]`}`;
}

/** Current compatibility grammar only; canonical aliases and consent integrate in Step 10. */
export function registerCommands(
  program: Command,
  context?: CommandContext,
  execute?: DispatchCommand,
): void {
  const registered = new Map<string, Command>();
  registered.set('[]', program);
  for (const descriptor of COMMAND_DESCRIPTORS) {
    const path = compatibilityPath(descriptor);
    const parent = registered.get(JSON.stringify(path.slice(0, -1)));
    const word = path.at(-1);
    if (parent === undefined || word === undefined) throw new CliError('cli_internal', '');
    const command =
      descriptor.opaqueParserHint === undefined ? parent.command(word) : parent.createCommand(word);
    if (descriptor.opaqueParserHint !== undefined) {
      parent.addCommand(command);
      const hint = descriptor.opaqueParserHint;
      command.configureOutput({
        ...parent.configureOutput(),
        outputError: (_message, write) => write(`${hint}\n`),
      });
      command.exitOverride((error) => {
        if (error.exitCode === 0) throw error;
        throw new CommanderError(error.exitCode, error.code, hint);
      });
    }
    command.description(descriptor.description);
    if (descriptor.allowExcessArguments !== undefined)
      command.allowExcessArguments(descriptor.allowExcessArguments);
    for (const positional of descriptor.positionals) {
      const name = `${positional.name}${positional.variadic ? '...' : ''}`;
      // Existing human argument-help layout is preserved; discovery separately carries descriptions.
      command.argument(positional.required ? `<${name}>` : `[${name}]`);
    }
    for (const option of compatibilityOptions(descriptor)) {
      const parsed = new Option(flags(option), option.description).makeOptionMandatory(
        option.required,
      );
      if (option.default !== undefined) parsed.default(option.default);
      if (option.conflicts.length > 0) parsed.conflicts([...option.conflicts]);
      command.addOption(parsed);
    }
    registerAction(command, descriptor, path, context, execute);
    registered.set(JSON.stringify(path), command);
  }
}

function registerAction(
  command: Command,
  descriptor: CommandDescriptor,
  path: readonly string[],
  context?: CommandContext,
  execute?: DispatchCommand,
): void {
  const name = path.join(' ');
  if (descriptor.availability === 'not_implemented') {
    command.action(() => {
      throw new CliError(
        'not_implemented',
        `\`relavium ${name}\` is not available yet (lands in ${descriptor.landsIn ?? 'a later workstream'}).`,
      );
    });
    return;
  }
  if (descriptor.executorId === undefined) {
    if (descriptor.requiredSubcommand !== undefined) {
      command.action(() => {
        if (context === undefined) throw missingContext(name);
        throw new CliError(
          'invalid_invocation',
          `\`relavium ${name}\` requires a subcommand (${descriptor.requiredSubcommand}).`,
        );
      });
    }
    return;
  }
  if (context === undefined) {
    command.action(() => {
      throw missingContext(name);
    });
    return;
  }
  const executorId = descriptor.executorId;
  command.action(async (...values: unknown[]) => {
    if (execute === undefined) throw new CliError('cli_internal', '');
    const positionals: string[] = [];
    for (let index = 0; index < descriptor.positionals.length; index += 1) {
      const value = values[index];
      const positional = descriptor.positionals[index];
      if (value === undefined && positional?.required !== true) continue;
      if (typeof value === 'string') positionals.push(value);
      else if (positional?.variadic === true) positionals.push(...stringVector(value));
      else throw new CliError('cli_internal', '');
    }
    const raw: unknown = command.opts();
    const options: Record<string, CommandOptionValue> = {};
    for (const option of compatibilityOptions(descriptor))
      options[option.binding] = readOption(raw, option.binding);
    context.result.exitCode = await execute(executorId, { positionals, options }, context);
  });
}

function missingContext(name: string): CliError {
  return new CliError('not_implemented', `\`relavium ${name}\` requires the CLI runtime context.`);
}

function stringVector(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new CliError('cli_internal', '');
  const values: readonly unknown[] = value;
  const strings: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string') throw new CliError('cli_internal', '');
    strings.push(item);
  }
  return strings;
}

function readOption(raw: unknown, binding: string): CommandOptionValue {
  if (typeof raw !== 'object' || raw === null) throw new CliError('cli_internal', '');
  const value: unknown = Object.getOwnPropertyDescriptor(raw, binding)?.value;
  if (value === undefined || typeof value === 'string' || typeof value === 'boolean') return value;
  return stringVector(value);
}
