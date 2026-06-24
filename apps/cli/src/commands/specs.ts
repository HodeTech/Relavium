import { randomUUID } from 'node:crypto';

import { createProviderStore } from '@relavium/db';
import type { Command } from 'commander';

import { loadResolvedConfig } from '../config/load.js';
import { openLocalDb } from '../db/open.js';
import { createProviderResolver } from '../engine/providers.js';
import { openHistoryStore } from '../history/open.js';
import { CliError } from '../process/errors.js';
import { type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import { readSecretFromStdin } from '../secrets/read-secret.js';
import { gateCommand } from './gate.js';
import { gateListCommand } from './gate-list.js';
import { listCommand } from './list.js';
import { logsCommand } from './logs.js';
import {
  runProviderCommand,
  type ProviderCommandArgs,
  type ProviderCommandDeps,
} from './provider.js';
import { runCommand } from './run.js';
import { statusCommand } from './status.js';

/**
 * The documented command surface (canonical home:
 * [commands.md](../../../../docs/reference/cli/commands.md)). `run` (2.D), `gate` + `gate list` (2.G/2.I),
 * `provider` (2.C), and the read commands `list` / `logs` / `status` (2.I) are real commands; the remaining
 * confirmed pre-chat commands are registered as clean "not-yet-available" stubs until their own workstreams
 * (the authoring commands at 2.J). The chat family (`chat`/`chat-resume`/`chat-list`/`chat-export`/`agent run`)
 * and `budget resume` land with their workstreams (2.M–2.Q; a tracked follow-up), not here.
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
  { name: 'agent', summary: 'Manage and run agents.', landsIn: 'workstreams 2.M–2.Q' },
  {
    name: 'init',
    summary: 'Initialize a .relavium/ directory in the current project.',
    landsIn: 'a later workstream',
  },
];

export function registerCommands(program: Command, ctx?: CommandContext): void {
  registerRun(program, ctx);
  registerGate(program, ctx);
  registerProvider(program, ctx);
  registerList(program, ctx);
  registerLogs(program, ctx);
  registerStatus(program, ctx);
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
      {
        io: ctx.io,
        global: ctx.global,
        // Production wires durable run history (2.H) + the keychain-backed key resolver (2.C): the real CLI
        // persists to ~/.relavium/history.db and resolves keys via the OS keychain → env var.
        openRunStore: openHistoryStore,
        providers: createProviderResolver(ctx.io.env, createOsKeychainStore()),
      },
    );
  });
}

/**
 * Register `relavium gate [runId]` (2.G — resolve a pending human gate over the durable resume substrate) plus
 * its `gate list [runId]` subcommand (2.I — list the pending gates so an operator picks a `gateId`). The
 * positional is OPTIONAL so commander routes `gate list …` to the subcommand; a bare `gate` (no runId, no
 * subcommand) falls through to the parent action, which reports the missing runId as a clean exit-2 invocation.
 */
function registerGate(program: Command, ctx?: CommandContext): void {
  const gate = program
    .command('gate [runId]')
    .description('Resolve a pending human gate (approve / reject / input).')
    .option('--approve', 'approve the gate')
    .option('--reject', 'reject the gate')
    .option('--comment <text>', 'a decision comment (with --approve / --reject)')
    .option('--input <value>', 'provide input for a gate_type=input gate (JSON, else a raw string)')
    .option(
      '--gate <gateId>',
      'which pending gate to resolve (required when more than one is pending)',
    );
  const gateList = gate
    .command('list [runId]')
    .description('List pending human gates (all paused runs, or one run).');

  if (ctx === undefined) {
    gate.action(() => {
      throw new CliError('not_implemented', '`relavium gate` requires the CLI runtime context.');
    });
    gateList.action(() => {
      throw new CliError(
        'not_implemented',
        '`relavium gate list` requires the CLI runtime context.',
      );
    });
    return;
  }

  gate.action(
    async (
      runId: string | undefined,
      opts: {
        approve?: boolean;
        reject?: boolean;
        comment?: string;
        input?: string;
        gate?: string;
      },
    ) => {
      if (runId === undefined) {
        // No runId and no `list` subcommand matched — a clean invocation fault, not a thrown stack.
        throw new CliError(
          'invalid_invocation',
          '`relavium gate` requires a <runId> (or use `relavium gate list`).',
        );
      }
      ctx.result.exitCode = await gateCommand(
        { runId, ...opts },
        {
          io: ctx.io,
          global: ctx.global,
          // Production resolves a post-gate agent's key via the OS keychain → env var (2.C), like `run`.
          providers: createProviderResolver(ctx.io.env, createOsKeychainStore()),
        },
      );
    },
  );

  gateList.action((runId: string | undefined) => {
    ctx.result.exitCode = gateListCommand(runId === undefined ? {} : { runId }, {
      io: ctx.io,
      global: ctx.global,
    });
  });
}

/** Register `relavium list [--agents]` (2.I) — the disk catalog + last-run overlay from durable history. */
function registerList(program: Command, ctx?: CommandContext): void {
  const list = program
    .command('list')
    .description('List discovered workflows (or, with --agents, agents) in the current project.')
    .option('--agents', 'list agents instead of workflows');
  if (ctx === undefined) {
    list.action(() => {
      throw new CliError('not_implemented', '`relavium list` requires the CLI runtime context.');
    });
    return;
  }
  list.action((opts: { agents?: boolean }) => {
    ctx.result.exitCode = listCommand(
      { agents: opts.agents ?? false },
      { io: ctx.io, global: ctx.global },
    );
  });
}

/** Register `relavium logs <runId>` (2.I) — replay a past run's persisted event stream. */
function registerLogs(program: Command, ctx?: CommandContext): void {
  const logs = program
    .command('logs <runId>')
    .description('Print the persisted event stream for a past run.');
  if (ctx === undefined) {
    logs.action(() => {
      throw new CliError('not_implemented', '`relavium logs` requires the CLI runtime context.');
    });
    return;
  }
  logs.action((runId: string) => {
    ctx.result.exitCode = logsCommand({ runId }, { io: ctx.io, global: ctx.global });
  });
}

/** Register `relavium status` (2.I) — the active/paused runs + their per-node status. */
function registerStatus(program: Command, ctx?: CommandContext): void {
  const status = program
    .command('status')
    .description('Show active/paused runs and their per-node status.');
  if (ctx === undefined) {
    status.action(() => {
      throw new CliError('not_implemented', '`relavium status` requires the CLI runtime context.');
    });
    return;
  }
  status.action(() => {
    ctx.result.exitCode = statusCommand({ io: ctx.io, global: ctx.global });
  });
}

/** Register `relavium provider` and its subcommands (2.C). Each opens the local db + keychain per invocation. */
function registerProvider(program: Command, ctx?: CommandContext): void {
  const provider = program
    .command('provider')
    .description('Manage providers and API keys in the OS keychain.');
  const list = provider
    .command('list')
    .description('List registered providers and whether a key is set.');
  const add = provider
    .command('add <name>')
    .description('Register a provider.')
    .option('--base-url <url>', 'override the provider base URL');
  const setKey = provider
    .command('set-key <name>')
    .description('Store a provider API key in the OS keychain (the key is read from stdin).');
  const removeKey = provider
    .command('remove-key <name>')
    .description('Remove a provider API key from the OS keychain.');
  const test = provider
    .command('test <name>')
    .description('Verify a provider key with a minimal live request.')
    .option('--model <id>', 'model to test with (defaults to a cheap known model)');

  if (ctx === undefined) {
    // No runtime context (bare buildProgram for help) — keep each subcommand a clean stub.
    for (const sub of [list, add, setKey, removeKey, test]) {
      sub.action(() => {
        throw new CliError(
          'not_implemented',
          '`relavium provider` requires the CLI runtime context.',
        );
      });
    }
    return;
  }

  const dispatch = async (args: ProviderCommandArgs): Promise<void> => {
    ctx.result.exitCode = await withProviderDeps(ctx, (deps) => runProviderCommand(args, deps));
  };
  list.action(async () => {
    await dispatch({ action: 'list' });
  });
  add.action(async (name: string, opts: { baseUrl?: string }) => {
    await dispatch({
      action: 'add',
      name,
      ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    });
  });
  setKey.action(async (name: string) => {
    await dispatch({ action: 'set-key', name });
  });
  removeKey.action(async (name: string) => {
    await dispatch({ action: 'remove-key', name });
  });
  test.action(async (name: string, opts: { model?: string }) => {
    await dispatch({
      action: 'test',
      name,
      ...(opts.model === undefined ? {} : { model: opts.model }),
    });
  });
}

/** Open the local db + OS keychain for one `provider` invocation, run the core, and always close the db. */
async function withProviderDeps(
  ctx: CommandContext,
  fn: (deps: ProviderCommandDeps) => Promise<ExitCode>,
): Promise<ExitCode> {
  const { homeDir } = loadResolvedConfig({
    cwd: ctx.global.cwd,
    configPath: ctx.global.configPath,
  });
  const { db, close } = openLocalDb(homeDir);
  try {
    const keychain = createOsKeychainStore(); // one native accessor, shared by the store-ref writes + the resolver
    const deps: ProviderCommandDeps = {
      io: ctx.io,
      store: createProviderStore(db, { uuid: () => randomUUID(), now: () => Date.now() }),
      keychain,
      resolver: createProviderResolver(ctx.io.env, keychain),
      readSecret: readSecretFromStdin,
    };
    return await fn(deps);
  } finally {
    close();
  }
}

/** First whitespace-delimited token of a command name — `logs <runId>` → `logs`. */
function commandWord(name: string): string {
  return name.split(' ', 1)[0] ?? name;
}
