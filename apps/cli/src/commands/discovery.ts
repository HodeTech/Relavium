import { CliError } from '../process/cli-error.js';
import {
  COMMAND_DESCRIPTORS,
  GLOBAL_OPTION_DESCRIPTORS,
  type CommandDescriptor,
  type OptionDescriptor,
  type PositionalDescriptor,
} from './descriptors.js';

export interface CliCommandDescriptor {
  readonly path: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly effect: CommandDescriptor['effect'];
  readonly availability: CommandDescriptor['availability'];
  readonly aliases: CommandDescriptor['aliases'];
  readonly positionals: readonly PositionalDescriptor[];
  readonly options: readonly OptionDescriptor[];
  readonly allowExcessArguments: boolean;
  readonly executorId?: string;
  readonly modeScope?: CommandDescriptor['modeScope'];
}

export interface CliCommandManifest {
  readonly type: 'command_manifest';
  readonly version: 1;
  readonly path: readonly string[];
  readonly globalOptions: readonly (OptionDescriptor & {
    readonly scope: 'position-independent';
  })[];
  readonly commands: readonly CliCommandDescriptor[];
}

/** Explicit projection prevents internal compatibility, parser or future loader state from leaking. */
function publicOption(option: OptionDescriptor): OptionDescriptor {
  return Object.freeze({
    binding: option.binding,
    spellings: option.spellings,
    deprecatedSpellings: option.deprecatedSpellings,
    arity: option.arity,
    ...(option.placeholder === undefined ? {} : { placeholder: option.placeholder }),
    type: option.type,
    repetition: option.repetition,
    negated: option.negated,
    required: option.required,
    description: option.description,
    ...(option.default === undefined ? {} : { default: option.default }),
    conflicts: option.conflicts,
  });
}

function projectCommand(entry: CommandDescriptor): CliCommandDescriptor {
  return Object.freeze({
    path: entry.path,
    label: entry.label,
    description: entry.description,
    effect: entry.effect,
    availability: entry.availability,
    aliases: entry.aliases,
    positionals: entry.positionals,
    options: Object.freeze(entry.options.map(publicOption)),
    allowExcessArguments: entry.allowExcessArguments !== false,
    ...(entry.executorId === undefined ? {} : { executorId: entry.executorId }),
    ...(entry.modeScope === undefined ? {} : { modeScope: entry.modeScope }),
  });
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

/** Pure approved DTO only. Production --help --json integration remains Step 10. */
export function discoverCommands(path: readonly string[] = []): CliCommandManifest {
  const selected =
    path.length === 0
      ? undefined
      : COMMAND_DESCRIPTORS.find(
          (entry) =>
            samePath(path, entry.path) || entry.aliases.some((alias) => samePath(path, alias.path)),
        );
  if (path.length > 0 && selected === undefined) {
    throw new CliError('invalid_invocation', 'Unknown command help path. Use relavium --help.');
  }
  const canonical = selected?.path ?? Object.freeze([]);
  return Object.freeze({
    type: 'command_manifest',
    version: 1,
    path: canonical,
    globalOptions: Object.freeze(
      GLOBAL_OPTION_DESCRIPTORS.map((option) =>
        Object.freeze({
          ...publicOption(option),
          scope: option.scope,
        }),
      ),
    ),
    commands: Object.freeze(
      COMMAND_DESCRIPTORS.filter((entry) =>
        canonical.every((part, index) => entry.path[index] === part),
      ).map(projectCommand),
    ),
  });
}
