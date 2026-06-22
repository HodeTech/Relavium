import type { Command } from 'commander';

import { CliError } from '../process/errors.js';

/**
 * The documented command surface (canonical home:
 * [commands.md](../../../../docs/reference/cli/commands.md)). Workstream 2.A registers the
 * **confirmed pre-chat surface** below so `--help` is complete for it and every command errors
 * **cleanly**; each command's real, framework-free core lands in its own workstream (`run` at
 * 2.D, the read commands at 2.I, the authoring commands at 2.J, the gate at 2.G, keys at 2.C).
 * The chat family (`chat`/`chat-resume`/`chat-list`/`chat-export`/`agent run`) and the
 * `gate list` / `budget resume` subcommands are **registered with their own workstreams**
 * (2.M–2.Q, 2.G), not here.
 */
interface CommandOption {
  readonly flags: string;
  readonly description: string;
}

interface CommandSpec {
  /** The `commander` command name with its argument grammar, e.g. `run <workflow>`. */
  readonly name: string;
  readonly summary: string;
  /** Where the real implementation lands — shown in the clean not-yet-available message. */
  readonly landsIn: string;
  readonly options?: readonly CommandOption[];
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'run <workflow>',
    summary: 'Execute a workflow (path or id), streaming progress.',
    landsIn: 'workstream 2.D',
    options: [{ flags: '--input <key=value...>', description: 'a workflow input (repeatable)' }],
  },
  {
    name: 'list',
    summary: 'List discovered workflows in the current project.',
    landsIn: 'workstream 2.I',
  },
  {
    name: 'logs <runId>',
    summary: 'Print the persisted event stream for a past run.',
    landsIn: 'workstream 2.I',
  },
  {
    name: 'status',
    summary: 'Show active/paused runs and their per-node status.',
    landsIn: 'workstream 2.I',
  },
  {
    name: 'gate <runId>',
    summary: 'Resolve a pending human gate (approve / reject / input).',
    landsIn: 'workstream 2.G',
  },
  {
    name: 'create',
    summary: 'Scaffold a new workflow or agent via an interactive wizard.',
    landsIn: 'workstream 2.J',
  },
  {
    name: 'import <path>',
    summary: 'Import an external workflow/agent YAML into the project.',
    landsIn: 'workstream 2.J',
  },
  {
    name: 'export <id>',
    summary: 'Export a workflow/agent to a portable YAML (secrets stripped).',
    landsIn: 'workstream 2.J',
  },
  {
    name: 'provider',
    summary: 'Manage providers and API keys in the OS keychain.',
    landsIn: 'workstream 2.C',
  },
  { name: 'agent', summary: 'Manage and run agents.', landsIn: 'workstreams 2.M–2.Q' },
  {
    name: 'init',
    summary: 'Initialize a .relavium/ directory in the current project.',
    landsIn: 'a later workstream',
  },
];

/** First whitespace-delimited token of a command name — `run <workflow>` → `run`. */
function commandWord(name: string): string {
  return name.split(' ', 1)[0] ?? name;
}

export function registerCommands(program: Command): void {
  for (const spec of COMMANDS) {
    const command = program.command(spec.name).description(spec.summary);
    for (const option of spec.options ?? []) {
      command.option(option.flags, option.description);
    }
    command.action(() => {
      throw new CliError(
        'not_implemented',
        `\`relavium ${commandWord(spec.name)}\` is not available yet (lands in ${spec.landsIn}).`,
      );
    });
  }
}
