import { randomUUID } from 'node:crypto';

import { createProviderStore } from '@relavium/db';
import type { Command } from 'commander';

import { loadResolvedConfig } from '../config/load.js';
import { openLocalDb } from '../db/open.js';
import { createProviderResolver } from '../engine/providers.js';
import { openHistoryStore } from '../history/open.js';
import { openSessionStore } from '../history/session-open.js';
import { CliError } from '../process/errors.js';
import { type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { selectChatDriver } from '../render/tui/chat-ink.js';
import { createMcpSecretResolver } from '../secrets/mcp-secret.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import { readSecretFromStdin } from '../secrets/read-secret.js';
import { agentRunCommand } from './agent-run.js';
import { chatCommand, chatResumeCommand } from './chat.js';
import { chatExportCommand } from './chat-export.js';
import { chatListCommand } from './chat-list.js';
import { createCommand } from './create.js';
import { exportCommand } from './export.js';
import { gateCommand } from './gate.js';
import { gateListCommand } from './gate-list.js';
import { importCommand } from './import.js';
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
 * confirmed pre-chat commands are registered as clean "not-yet-available" stubs until their own workstreams.
 * The whole chat family is now live — `chat` (2.M), `chat-resume` (2.N), `chat-list` (2.O), `chat-export`
 * (2.P), and `agent run` (2.Q) — via their `register*` functions below. The remaining `STUB_COMMANDS` are the
 * authoring commands `create` / `import` / `export` (2.J), `init` (a later workstream), and `budget resume`
 * (a tracked follow-up) — each shows the documented "not available yet (lands in …)" message (not commander's
 * "unknown command") until it lands.
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
    // One native keychain accessor, shared by the key resolver (2.C) + the MCP named-secret resolver (2.R §6).
    const keychain = createOsKeychainStore();
    ctx.result.exitCode = await runCommand(
      { workflow, input: opts.input ?? [] },
      {
        io: ctx.io,
        global: ctx.global,
        // Production wires durable run history (2.H) + the keychain-backed key resolver (2.C): the real CLI
        // persists to ~/.relavium/history.db and resolves keys via the OS keychain → env var.
        openRunStore: openHistoryStore,
        providers: createProviderResolver(ctx.io.env, keychain),
        mcpSecretResolver: createMcpSecretResolver(ctx.io.env, keychain),
      },
    );
  });
}

/**
 * Register `relavium chat [--agent <ref>]` (2.M — the agent-first interactive REPL over `AgentSession`).
 * Production wires the keychain-backed key resolver (2.C), durable session persistence (over the shared
 * `history.db`, 2.H/ADR-0050), and the TTY-aware driver (ink for a real terminal, the plain line loop
 * otherwise). `/exit` ends the session with exit code 4.
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
    const keychain = createOsKeychainStore();
    ctx.result.exitCode = await chatCommand(
      { agent: opts.agent },
      {
        io: ctx.io,
        global: ctx.global,
        providers: createProviderResolver(ctx.io.env, keychain),
        mcpSecretResolver: createMcpSecretResolver(ctx.io.env, keychain),
        openSessionStore,
        drive: selectChatDriver,
      },
    );
  });
}

/**
 * Register `relavium chat-resume <sessionId>` (2.N) — reload a persisted session from `history.db` and continue
 * it in the same REPL. Production wires the keychain-backed key resolver (2.C) + the TTY-aware driver, like
 * `chat`. An unknown session id is a clean exit-2 invocation fault; `/exit` ends with exit code 4.
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
    const keychain = createOsKeychainStore();
    ctx.result.exitCode = await chatResumeCommand(
      { sessionId },
      {
        io: ctx.io,
        global: ctx.global,
        providers: createProviderResolver(ctx.io.env, keychain),
        mcpSecretResolver: createMcpSecretResolver(ctx.io.env, keychain),
        openSessionStore,
        drive: selectChatDriver,
      },
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
  chatList.action(() => {
    // Pass the real opener explicitly (consistent with registerChat) so the production wiring is visible at
    // the registration site and a future specs-level integration test can inject an in-memory store.
    ctx.result.exitCode = chatListCommand({ io: ctx.io, global: ctx.global, openSessionStore });
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
  chatExport.action((sessionId: string, opts: { out?: string; force?: boolean }) => {
    ctx.result.exitCode = chatExportCommand(
      {
        sessionId,
        ...(opts.out === undefined ? {} : { out: opts.out }),
        force: opts.force ?? false,
      },
      { io: ctx.io, global: ctx.global, openSessionStore },
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
    ctx.result.exitCode = await createCommand(
      { force: opts.force ?? false },
      { io: ctx.io, global: ctx.global },
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
  exportCmd.action((id: string, opts: { out?: string; force?: boolean }) => {
    ctx.result.exitCode = exportCommand(
      { id, ...(opts.out === undefined ? {} : { out: opts.out }), force: opts.force ?? false },
      { io: ctx.io, global: ctx.global },
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
  importCmd.action((path: string, opts: { force?: boolean }) => {
    ctx.result.exitCode = importCommand(
      { path, force: opts.force ?? false },
      { io: ctx.io, global: ctx.global },
    );
  });
}

/**
 * Register `relavium agent run <agent>` (2.Q) — a one-shot, non-interactive agent invocation over the same
 * `AgentSession` infra. The prompt is piped on stdin; `--input k=v` adds `{{ctx.*}}` variables; `--fixture`
 * replays a recorded cassette (offline). Production resolves keys via the OS keychain (skipped under
 * `--fixture`). A bare `relavium agent` (no subcommand) is a clean exit-2 invocation fault.
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
    const keychain = createOsKeychainStore();
    ctx.result.exitCode = await agentRunCommand(
      {
        agent: agentRef,
        input: opts.input ?? [],
        ...(opts.fixture === undefined ? {} : { fixture: opts.fixture }),
      },
      {
        io: ctx.io,
        global: ctx.global,
        // A non-fixture run resolves keys via the OS keychain → env var (2.C), like `run`/`chat`.
        providers: createProviderResolver(ctx.io.env, keychain),
        mcpSecretResolver: createMcpSecretResolver(ctx.io.env, keychain),
      },
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
