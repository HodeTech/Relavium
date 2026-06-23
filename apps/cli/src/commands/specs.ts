import type { Command } from 'commander';

import { openHistoryStore } from '../history/open.js';
import { CliError } from '../process/errors.js';
import type { ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { runCommand } from './run.js';

/**
 * The documented command surface (canonical home:
 * [commands.md](../../../../docs/reference/cli/commands.md)). `run` is the real command (2.D); the
 * remaining confirmed pre-chat commands are registered as clean "not-yet-available" stubs until their
 * own workstreams (the read commands at 2.I, the authoring commands at 2.J, the gate at 2.G, keys at
 * 2.C). The chat family (`chat`/`chat-resume`/`chat-list`/`chat-export`/`agent run`) and the
 * `gate list` / `budget resume` subcommands land with their workstreams (2.M–2.Q, 2.G), not here.
 */

/** The runtime context the real commands need; the boundary reads `result.exitCode` after parse. */
export interface CommandContext {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly result: { exitCode?: ExitCode };
}

interface StubSpec {
  readonly name: string;
  readonly summary: string;
  readonly landsIn: string;
}

const STUB_COMMANDS: readonly StubSpec[] = [
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

export function registerCommands(program: Command, ctx?: CommandContext): void {
  registerRun(program, ctx);
  for (const spec of STUB_COMMANDS) {
    program
      .command(spec.name)
      .description(spec.summary)
      .action(() => {
        throw new CliError(
          'not_implemented',
          `\`relavium ${commandWord(spec.name)}\` is not available yet (lands in ${spec.landsIn}).`,
        );
      });
  }
}

function registerRun(program: Command, ctx?: CommandContext): void {
  const run = program
    .command('run <workflow>')
    .description('Execute a workflow (path or id), streaming progress.')
    .option('--input <key=value...>', 'a workflow input (repeatable)');

  if (ctx === undefined) {
    // No runtime context (e.g. a bare buildProgram for help rendering) — keep it a clean stub.
    run.action(() => {
      throw new CliError('not_implemented', '`relavium run` requires the CLI runtime context.');
    });
    return;
  }

  run.action(async (workflow: string, opts: { input?: readonly string[] }) => {
    ctx.result.exitCode = await runCommand(
      { workflow, input: opts.input ?? [] },
      // Production wires durable run history (2.H) — the real CLI persists to ~/.relavium/history.db.
      { io: ctx.io, global: ctx.global, openRunStore: openHistoryStore },
    );
  });
}

/** First whitespace-delimited token of a command name — `logs <runId>` → `logs`. */
function commandWord(name: string): string {
  return name.split(' ', 1)[0] ?? name;
}
