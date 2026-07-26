import type { Command } from 'commander';

import { CliError } from '../process/errors.js';
import { type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { executeCommand } from './dispatch.js';

/**
 * The documented command surface (canonical home:
 * [commands.md](../../../../docs/reference/cli/commands.md)). Every real command's registration here is a thin
 * `commander` adapter: it parses argv into a uniform {@link import('./dispatch.js').CommandInput} and calls the
 * shared {@link executeCommand} table ([dispatch.ts](dispatch.ts), [ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md)),
 * so the per-command dependency wiring lives once and the `commander` / palette / slash surfaces can never
 * diverge. The remaining `STUB_COMMANDS` are `init` (a later workstream) and `budget` (a tracked follow-up) —
 * each shows the documented "not available yet (lands in …)" message until it lands.
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

export const STUB_COMMANDS: readonly StubSpec[] = [
  {
    name: 'budget',
    summary: 'Budget commands (resume a budget-paused run, etc.) — not yet available.',
    landsIn: 'a tracked follow-up',
  },
  {
    name: 'init',
    summary: 'Initialize a .relavium/ directory in the current project.',
    landsIn: 'a later workstream',
  },
];

export function registerCommands(program: Command, ctx?: CommandContext): void {
  registerRun(program, ctx);
  registerChat(program, ctx);
  registerChatResume(program, ctx);
  registerChatList(program, ctx);
  registerChatExport(program, ctx);
  registerCreate(program, ctx);
  registerExport(program, ctx);
  registerImport(program, ctx);
  registerAgent(program, ctx);
  registerGate(program, ctx);
  registerModels(program, ctx);
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
    ctx.result.exitCode = await executeCommand(
      'run',
      { positionals: [workflow], options: { input: opts.input } },
      ctx,
    );
  });
}

/**
 * Register `relavium chat [--agent <ref>]` (2.M — the agent-first interactive REPL over `AgentSession`). The
 * dispatch wires the keychain-backed key resolver (2.C), durable session persistence (2.H/ADR-0050), and the
 * TTY-aware driver. `/exit` ends the session with exit code 4.
 */
function registerChat(program: Command, ctx?: CommandContext): void {
  const chat = program
    .command('chat')
    .description('Start an interactive agent chat session (REPL).')
    .option('--agent <ref>', 'bind a specific agent (.agent.yaml path or .relavium/ id)');

  if (ctx === undefined) {
    chat.action(() => {
      throw new CliError('not_implemented', '`relavium chat` requires the CLI runtime context.');
    });
    return;
  }

  chat.action(async (opts: { agent?: string }) => {
    ctx.result.exitCode = await executeCommand(
      'chat',
      { positionals: [], options: { agent: opts.agent } },
      ctx,
    );
  });
}

/**
 * Register `relavium chat-resume <sessionId>` (2.N) — reload a persisted session from `history.db` and continue
 * it in the same REPL. An unknown session id is a clean exit-2 invocation fault; `/exit` ends with exit code 4.
 */
function registerChatResume(program: Command, ctx?: CommandContext): void {
  const chatResume = program
    .command('chat-resume <sessionId>')
    .description('Reload a persisted session from history.db and continue the conversation.');

  if (ctx === undefined) {
    chatResume.action(() => {
      throw new CliError(
        'not_implemented',
        '`relavium chat-resume` requires the CLI runtime context.',
      );
    });
    return;
  }

  chatResume.action(async (sessionId: string) => {
    ctx.result.exitCode = await executeCommand(
      'chat-resume',
      { positionals: [sessionId], options: {} },
      ctx,
    );
  });
}

/** Register `relavium chat-list` (2.O) — list past agent sessions from durable `history.db` (id, agent, last activity). */
function registerChatList(program: Command, ctx?: CommandContext): void {
  const chatList = program
    .command('chat-list')
    .description('List past agent sessions (id, agent, title, last activity).');
  if (ctx === undefined) {
    chatList.action(() => {
      throw new CliError(
        'not_implemented',
        '`relavium chat-list` requires the CLI runtime context.',
      );
    });
    return;
  }
  chatList.action(async () => {
    ctx.result.exitCode = await executeCommand('chat-list', { positionals: [], options: {} }, ctx);
  });
}

/**
 * Register `relavium chat-export <sessionId>` (2.P) — export a persisted session to a `.relavium.yaml`
 * scaffold for review ([ADR-0026](../../../../docs/decisions/0026-session-export-to-workflow.md)). Writes
 * `<id>.relavium.yaml` in cwd by default; `--out <path>` overrides, `--force` overwrites an existing file.
 */
function registerChatExport(program: Command, ctx?: CommandContext): void {
  const chatExport = program
    .command('chat-export <sessionId>')
    .description('Export a session to a .relavium.yaml scaffold for review (ADR-0026).')
    .option('--out <path>', 'write the scaffold here instead of <id>.relavium.yaml')
    .option('--force', 'overwrite an existing file at the target path');
  if (ctx === undefined) {
    chatExport.action(() => {
      throw new CliError(
        'not_implemented',
        '`relavium chat-export` requires the CLI runtime context.',
      );
    });
    return;
  }
  chatExport.action(async (sessionId: string, opts: { out?: string; force?: boolean }) => {
    ctx.result.exitCode = await executeCommand(
      'chat-export',
      { positionals: [sessionId], options: { out: opts.out, force: opts.force } },
      ctx,
    );
  });
}

/**
 * Register `relavium create` (2.J) — an interactive `@clack/prompts` wizard that scaffolds a new agent or a
 * minimal single-agent workflow as schema-validated, git-ready YAML under `.relavium/`. Needs an interactive
 * terminal (fails loud under `--json` / non-TTY); a name collision is exit 2 unless `--force`. No keychain/db.
 */
function registerCreate(program: Command, ctx?: CommandContext): void {
  const create = program
    .command('create')
    .description('Scaffold a new agent or workflow via an interactive wizard.')
    .option('--force', 'overwrite an existing project entry with the same id');
  if (ctx === undefined) {
    create.action(() => {
      throw new CliError('not_implemented', '`relavium create` requires the CLI runtime context.');
    });
    return;
  }
  create.action(async (opts: { force?: boolean }) => {
    ctx.result.exitCode = await executeCommand(
      'create',
      { positionals: [], options: { force: opts.force } },
      ctx,
    );
  });
}

/**
 * Register `relavium export <id>` (2.J) — write a portable, share-safe copy of a project workflow/agent
 * (re-serialized from the validated AST; `{{secrets.*}}` placeholders preserved, no resolved secret). Default
 * target is `<id>.<suffix>` in cwd; `--out` overrides, `--force` overwrites. Pure YAML I/O — no keychain/db.
 */
function registerExport(program: Command, ctx?: CommandContext): void {
  const exportCmd = program
    .command('export <id>')
    .description(
      'Export a workflow/agent to a portable YAML (secret references stay placeholdered).',
    )
    .option('--out <path>', 'write the copy here instead of <id>.<suffix> in cwd')
    .option('--force', 'overwrite an existing file at the target path');
  if (ctx === undefined) {
    exportCmd.action(() => {
      throw new CliError('not_implemented', '`relavium export` requires the CLI runtime context.');
    });
    return;
  }
  exportCmd.action(async (id: string, opts: { out?: string; force?: boolean }) => {
    ctx.result.exitCode = await executeCommand(
      'export',
      { positionals: [id], options: { out: opts.out, force: opts.force } },
      ctx,
    );
  });
}

/**
 * Register `relavium import <path>` (2.J) — copy an external workflow/agent YAML into the project `.relavium/`,
 * validating schema + slug uniqueness, writing the re-serialized doc to `.relavium/<kind>/<id>.<suffix>`. A
 * collision is exit 2 unless `--force`. Pure YAML I/O — no keychain/db.
 */
function registerImport(program: Command, ctx?: CommandContext): void {
  const importCmd = program
    .command('import <path>')
    .description(
      'Import an external workflow/agent YAML into the project (validated, deduplicated).',
    )
    .option('--force', 'overwrite an existing project entry with the same id');
  if (ctx === undefined) {
    importCmd.action(() => {
      throw new CliError('not_implemented', '`relavium import` requires the CLI runtime context.');
    });
    return;
  }
  importCmd.action(async (path: string, opts: { force?: boolean }) => {
    ctx.result.exitCode = await executeCommand(
      'import',
      { positionals: [path], options: { force: opts.force } },
      ctx,
    );
  });
}

/**
 * Register `relavium agent run <agent>` (2.Q) — a one-shot, non-interactive agent invocation over the same
 * `AgentSession` infra. The prompt is piped on stdin; `--input k=v` adds `{{ctx.*}}` variables; `--fixture`
 * replays a recorded cassette (offline). A bare `relavium agent` (no subcommand) is a clean exit-2 fault.
 */
function registerAgent(program: Command, ctx?: CommandContext): void {
  const agent = program.command('agent').description('Manage and run agents.');
  const run = agent
    .command('run <agent>')
    .description(
      'Run a single agent one-shot (prompt on stdin); --fixture replays a recorded cassette.',
    )
    .option('--input <key=value...>', 'a session {{ctx.*}} variable (repeatable)')
    .option('--fixture <path>', 'replay a recorded LLM cassette (deterministic, offline)');

  if (ctx === undefined) {
    run.action(() => {
      throw new CliError(
        'not_implemented',
        '`relavium agent run` requires the CLI runtime context.',
      );
    });
    agent.action(() => {
      throw new CliError('not_implemented', '`relavium agent` requires the CLI runtime context.');
    });
    return;
  }

  run.action(async (agentRef: string, opts: { input?: readonly string[]; fixture?: string }) => {
    ctx.result.exitCode = await executeCommand(
      'agent.run',
      { positionals: [agentRef], options: { input: opts.input, fixture: opts.fixture } },
      ctx,
    );
  });
  // A bare `relavium agent` (no `run`) is a clean invocation fault, not a thrown stack.
  agent.action(() => {
    throw new CliError('invalid_invocation', '`relavium agent` requires a subcommand (run).');
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
      ctx.result.exitCode = await executeCommand(
        'gate',
        {
          positionals: runId === undefined ? [] : [runId],
          options: {
            approve: opts.approve,
            reject: opts.reject,
            comment: opts.comment,
            input: opts.input,
            gate: opts.gate,
          },
        },
        ctx,
      );
    },
  );

  gateList.action(async (runId: string | undefined) => {
    ctx.result.exitCode = await executeCommand(
      'gate.list',
      { positionals: runId === undefined ? [] : [runId], options: {} },
      ctx,
    );
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
  list.action(async (opts: { agents?: boolean }) => {
    ctx.result.exitCode = await executeCommand(
      'list',
      { positionals: [], options: { agents: opts.agents } },
      ctx,
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
  logs.action(async (runId: string) => {
    ctx.result.exitCode = await executeCommand('logs', { positionals: [runId], options: {} }, ctx);
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
  status.action(async () => {
    ctx.result.exitCode = await executeCommand('status', { positionals: [], options: {} }, ctx);
  });
}

/**
 * Register `relavium models` (list the cached catalog) + `relavium models refresh` (force a live re-fetch)
 * (2.5.G S5, [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md)). The parent `models` action
 * lists the cache (refreshing on first run if empty); the `refresh` subcommand blocks on a live re-fetch and
 * reports per-provider outcomes. Both honor `--json`. Each dispatch opens the local db + keychain per invocation.
 */
function registerModels(program: Command, ctx?: CommandContext): void {
  const models = program
    .command('models')
    .description('List the cached model catalog (refreshes on first run if empty).');
  const refresh = models
    .command('refresh')
    .description(
      "Re-fetch what we know about models: each connected provider's live list, and the models.dev catalog.",
    )
    .option('--providers', "availability only — each connected provider's live model list")
    .option('--catalog', 'metadata only — prices, ceilings and reasoning tiers from models.dev');
  const pricing = models
    .command('pricing <model>')
    .description(
      'Set your own price for a model — it overrides the catalog (you hold the invoice). --clear removes it.',
    )
    .requiredOption('--provider <slug>', 'the provider that serves the model (must be registered)')
    // NOT `requiredOption`: `--clear` takes none of the three price flags, and commander would reject the invocation
    // before the command ever sees it. The real rule — exactly one of "set a price" or "--clear" — is enforced in
    // `buildModelsPricingArgs`, which can express it; commander's required-flag check cannot.
    .option(
      '--input <usd-per-mtok>',
      'input (prompt) price, USD per million tokens (required unless --clear)',
    )
    .option(
      '--output <usd-per-mtok>',
      'output (completion) price, USD per million tokens (required unless --clear)',
    )
    .option(
      '--cached <usd-per-mtok>',
      "cache-read price, USD per million tokens; omitted ⇒ the catalog's cache discount, applied to your input rate",
    )
    .option('--clear', "remove your price for this model — it falls back to the catalog's");

  if (ctx === undefined) {
    models.action(() => {
      throw new CliError('not_implemented', '`relavium models` requires the CLI runtime context.');
    });
    refresh.action(() => {
      throw new CliError(
        'not_implemented',
        '`relavium models refresh` requires the CLI runtime context.',
      );
    });
    pricing.action(() => {
      throw new CliError(
        'not_implemented',
        '`relavium models pricing` requires the CLI runtime context.',
      );
    });
    return;
  }

  models.action(async () => {
    ctx.result.exitCode = await executeCommand('models', { positionals: [], options: {} }, ctx);
  });
  refresh.action(async (opts: { providers?: boolean; catalog?: boolean }) => {
    ctx.result.exitCode = await executeCommand(
      'models.refresh',
      { positionals: [], options: { providers: opts.providers, catalog: opts.catalog } },
      ctx,
    );
  });
  pricing.action(
    async (
      model: string,
      opts: {
        provider?: string;
        input?: string;
        output?: string;
        cached?: string;
        clear?: boolean;
      },
    ) => {
      ctx.result.exitCode = await executeCommand(
        'models.pricing',
        {
          positionals: [model],
          options: {
            provider: opts.provider,
            input: opts.input,
            output: opts.output,
            cached: opts.cached,
            clear: opts.clear,
          },
        },
        ctx,
      );
    },
  );
}

/** Register `relavium provider` and its subcommands (2.C). Each dispatch opens the local db + keychain per invocation. */
function registerProvider(program: Command, ctx?: CommandContext): void {
  const provider = program
    .command('provider')
    .description('Manage providers and API keys in the OS keychain.');
  const list = provider
    .command('list')
    .description('List registered providers and whether a key is set.')
    .option('--verify', 'additionally run a live key-verification probe per provider');
  const add = provider
    .command('add <name>')
    .description('Register a provider.')
    .option('--base-url <url>', 'override the provider base URL')
    .option(
      '--pricing-url <url>',
      'override the pricing reference page (where you find model prices)',
    );
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

  list.action(async (opts: { verify?: boolean }) => {
    ctx.result.exitCode = await executeCommand(
      'provider.list',
      { positionals: [], options: { verify: opts.verify } },
      ctx,
    );
  });
  add.action(async (name: string, opts: { baseUrl?: string; pricingUrl?: string }) => {
    ctx.result.exitCode = await executeCommand(
      'provider.add',
      { positionals: [name], options: { baseUrl: opts.baseUrl, pricingUrl: opts.pricingUrl } },
      ctx,
    );
  });
  setKey.action(async (name: string) => {
    ctx.result.exitCode = await executeCommand(
      'provider.set-key',
      { positionals: [name], options: {} },
      ctx,
    );
  });
  removeKey.action(async (name: string) => {
    ctx.result.exitCode = await executeCommand(
      'provider.remove-key',
      { positionals: [name], options: {} },
      ctx,
    );
  });
  test.action(async (name: string, opts: { model?: string }) => {
    ctx.result.exitCode = await executeCommand(
      'provider.test',
      { positionals: [name], options: { model: opts.model } },
      ctx,
    );
  });
}

/** First whitespace-delimited token of a command name — `logs <runId>` → `logs`. */
function commandWord(name: string): string {
  return name.split(' ', 1)[0] ?? name;
}
