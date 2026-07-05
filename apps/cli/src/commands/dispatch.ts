import { randomUUID } from 'node:crypto';

import { createModelCatalogStore, createProviderStore } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { openLocalDb } from '../db/open.js';
import { createModelRefreshService } from '../engine/model-refresh.js';
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  createProviderResolver,
} from '../engine/providers.js';
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
import { agentRunCommand, type AgentRunCommandArgs } from './agent-run.js';
import { chatCommand, chatResumeCommand, type ChatCommandArgs } from './chat.js';
import { chatExportCommand, type ChatExportCommandArgs } from './chat-export.js';
import { chatListCommand } from './chat-list.js';
import { createCommand } from './create.js';
import { exportCommand, type ExportCommandArgs } from './export.js';
import { gateCommand, type GateCommandArgs } from './gate.js';
import { gateListCommand } from './gate-list.js';
import { importCommand, type ImportCommandArgs } from './import.js';
import { listCommand } from './list.js';
import { logsCommand } from './logs.js';
import { modelsCommand, type ModelsCommandArgs } from './models.js';
import {
  runProviderCommand,
  type ProviderCommandArgs,
  type ProviderCommandDeps,
} from './provider.js';
import { runCommand, type RunCommandArgs } from './run.js';
import { statusCommand } from './status.js';

/**
 * The shared **command dispatch table** ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C). Every surface — the `commander` actions ([specs.ts](specs.ts)), and (later in 2.5.C) the `/` palette
 * and the in-REPL slash commands — calls {@link executeCommand} keyed by the manifest id, so the per-command
 * dependency wiring (keychain, provider resolver, the durable stores) lives in exactly ONE place and the surfaces
 * can never diverge. Each entry is a {@link CommandExecutor} that turns a uniform {@link CommandInput} into the
 * command core's typed args (the pure `build*Args` functions — unit-tested) and assembles its production deps.
 *
 * The `build*Args` extraction is the only behaviour-sensitive change vs the old inline `register*` bodies, so it
 * is kept pure and exhaustively tested; the dep assembly below is copied verbatim from those bodies.
 */

/** A parsed option value as a surface hands it in — a string, a boolean flag, a repeatable list, or absent. */
export type CommandOptionValue = string | boolean | readonly string[] | undefined;

/**
 * The uniform, surface-agnostic parsed input a command executor consumes (commander argv, or a slash line). It is
 * deliberately LOW-LEVEL: an option value is just a string / boolean / repeatable list, with no per-command
 * schema. Each command's pure `build*Args` extractor below owns the interpretation; a slash/palette surface
 * (2.5.C) builds a `CommandInput` against the manifest's arg shapes, so option arity (a repeatable `--input` vs a
 * single `--out`) is resolved from the manifest, never guessed from this shape.
 */
export interface CommandInput {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, CommandOptionValue>>;
}

/** The runtime channels a command needs; the boundary reads the returned {@link ExitCode}. */
export interface DispatchContext {
  readonly io: CliIo;
  readonly global: GlobalOptions;
}

/** One command's executor — uniform input + context in, an exit code out. */
export type CommandExecutor = (input: CommandInput, ctx: DispatchContext) => Promise<ExitCode>;

// ── input extractors (pure) ─────────────────────────────────────────────────

/** A required positional; a missing one is a clean invocation fault (the surface guarantees it via the grammar). */
export function reqPositional(input: CommandInput, index: number, name: string): string {
  const value = input.positionals[index];
  if (value === undefined) {
    throw new CliError('invalid_invocation', `missing argument <${name}>.`);
  }
  return value;
}

/** An optional positional (`undefined` when absent). */
export function optPositional(input: CommandInput, index: number): string | undefined {
  return input.positionals[index];
}

/** A string option value (`undefined` for an absent or non-string value). */
export function optString(value: CommandOptionValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A boolean flag — present-and-true ⇒ `true`, anything else ⇒ `false` (commander gives `true | undefined`). */
export function boolFlag(value: CommandOptionValue): boolean {
  return value === true;
}

/** A repeatable string option as a list (`[]` when absent) — narrowed by elimination, no `any` from `Array.isArray`. */
export function stringList(value: CommandOptionValue): readonly string[] {
  if (value === undefined || typeof value === 'string' || typeof value === 'boolean') return [];
  return value;
}

// ── per-command arg builders (pure: CommandInput → the core's typed args) ─────

export function buildRunArgs(input: CommandInput): RunCommandArgs {
  return {
    workflow: reqPositional(input, 0, 'workflow'),
    input: stringList(input.options['input']),
  };
}

export function buildChatArgs(input: CommandInput): ChatCommandArgs {
  return { agent: optString(input.options['agent']) };
}

export function buildChatExportArgs(input: CommandInput): ChatExportCommandArgs {
  const out = optString(input.options['out']);
  return {
    sessionId: reqPositional(input, 0, 'sessionId'),
    force: boolFlag(input.options['force']),
    ...(out === undefined ? {} : { out }),
  };
}

export function buildExportArgs(input: CommandInput): ExportCommandArgs {
  const out = optString(input.options['out']);
  return {
    id: reqPositional(input, 0, 'id'),
    force: boolFlag(input.options['force']),
    ...(out === undefined ? {} : { out }),
  };
}

export function buildImportArgs(input: CommandInput): ImportCommandArgs {
  return { path: reqPositional(input, 0, 'path'), force: boolFlag(input.options['force']) };
}

export function buildAgentRunArgs(input: CommandInput): AgentRunCommandArgs {
  const fixture = optString(input.options['fixture']);
  return {
    agent: reqPositional(input, 0, 'agent'),
    input: stringList(input.options['input']),
    ...(fixture === undefined ? {} : { fixture }),
  };
}

/** `gate <runId>` — a missing runId is a clean invocation fault (a bare `gate` without the `list` subcommand). */
export function buildGateArgs(input: CommandInput): GateCommandArgs {
  const runId = optPositional(input, 0);
  if (runId === undefined) {
    throw new CliError(
      'invalid_invocation',
      '`relavium gate` requires a <runId> (or use `relavium gate list`).',
    );
  }
  const comment = optString(input.options['comment']);
  const inputValue = optString(input.options['input']);
  const gate = optString(input.options['gate']);
  return {
    runId,
    approve: boolFlag(input.options['approve']),
    reject: boolFlag(input.options['reject']),
    ...(comment === undefined ? {} : { comment }),
    ...(inputValue === undefined ? {} : { input: inputValue }),
    ...(gate === undefined ? {} : { gate }),
  };
}

export function buildProviderAddArgs(input: CommandInput): ProviderCommandArgs {
  const baseUrl = optString(input.options['baseUrl']);
  return {
    action: 'add',
    name: reqPositional(input, 0, 'name'),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

export function buildProviderTestArgs(input: CommandInput): ProviderCommandArgs {
  const model = optString(input.options['model']);
  return {
    action: 'test',
    name: reqPositional(input, 0, 'name'),
    ...(model === undefined ? {} : { model }),
  };
}

// ── executors (production dep wiring, copied verbatim from the old register* bodies) ──

/** One native keychain accessor, shared by the key resolver (2.C) + the MCP named-secret resolver (2.R §6). */
function keyResolvers(io: CliIo): {
  providers: ReturnType<typeof createProviderResolver>;
  mcpSecretResolver: ReturnType<typeof createMcpSecretResolver>;
} {
  const keychain = createOsKeychainStore();
  return {
    providers: createProviderResolver(io.env, keychain),
    mcpSecretResolver: createMcpSecretResolver(io.env, keychain),
  };
}

/** The env-backed provider resolver alone (a command — like `gate` — that needs keys but not MCP secrets). */
function providerResolver(io: CliIo): ReturnType<typeof createProviderResolver> {
  return createProviderResolver(io.env, createOsKeychainStore());
}

const executeRun: CommandExecutor = (input, ctx) =>
  runCommand(buildRunArgs(input), {
    io: ctx.io,
    global: ctx.global,
    openRunStore: openHistoryStore,
    ...keyResolvers(ctx.io),
  });

const executeChat: CommandExecutor = (input, ctx) =>
  chatCommand(buildChatArgs(input), {
    io: ctx.io,
    global: ctx.global,
    ...keyResolvers(ctx.io),
    openSessionStore,
    drive: selectChatDriver,
  });

const executeChatResume: CommandExecutor = (input, ctx) =>
  chatResumeCommand(
    { sessionId: reqPositional(input, 0, 'sessionId') },
    {
      io: ctx.io,
      global: ctx.global,
      ...keyResolvers(ctx.io),
      openSessionStore,
      drive: selectChatDriver,
    },
  );

const executeChatList: CommandExecutor = (_input, ctx) =>
  Promise.resolve(chatListCommand({ io: ctx.io, global: ctx.global, openSessionStore }));

const executeChatExport: CommandExecutor = (input, ctx) =>
  Promise.resolve(
    chatExportCommand(buildChatExportArgs(input), {
      io: ctx.io,
      global: ctx.global,
      openSessionStore,
    }),
  );

const executeCreate: CommandExecutor = (input, ctx) =>
  createCommand({ force: boolFlag(input.options['force']) }, { io: ctx.io, global: ctx.global });

const executeExport: CommandExecutor = (input, ctx) =>
  Promise.resolve(exportCommand(buildExportArgs(input), { io: ctx.io, global: ctx.global }));

const executeImport: CommandExecutor = (input, ctx) =>
  Promise.resolve(importCommand(buildImportArgs(input), { io: ctx.io, global: ctx.global }));

const executeAgentRun: CommandExecutor = (input, ctx) =>
  agentRunCommand(buildAgentRunArgs(input), {
    io: ctx.io,
    global: ctx.global,
    ...keyResolvers(ctx.io),
  });

const executeGate: CommandExecutor = (input, ctx) =>
  gateCommand(buildGateArgs(input), {
    io: ctx.io,
    global: ctx.global,
    // Production resolves a post-gate agent's key via the OS keychain → env var (2.C), like `run`.
    providers: providerResolver(ctx.io),
  });

const executeGateList: CommandExecutor = (input, ctx) => {
  const runId = optPositional(input, 0);
  return Promise.resolve(
    gateListCommand(runId === undefined ? {} : { runId }, { io: ctx.io, global: ctx.global }),
  );
};

const executeList: CommandExecutor = (input, ctx) =>
  Promise.resolve(
    listCommand({ agents: boolFlag(input.options['agents']) }, { io: ctx.io, global: ctx.global }),
  );

const executeLogs: CommandExecutor = (input, ctx) =>
  Promise.resolve(
    logsCommand({ runId: reqPositional(input, 0, 'runId') }, { io: ctx.io, global: ctx.global }),
  );

const executeStatus: CommandExecutor = (_input, ctx) =>
  Promise.resolve(statusCommand({ io: ctx.io, global: ctx.global }));

/**
 * Open the local db + OS keychain for one `models` invocation, wire the S5 refresh service over the S4 catalog
 * store + the S2 `listModels?` seam, run the core, and always close the db (2.5.G S5, ADR-0064). The key
 * resolver reads a provider key only inside the refresh (keychain → env); the catalog holds no key.
 */
async function withModelsDeps(ctx: DispatchContext, args: ModelsCommandArgs): Promise<ExitCode> {
  const { homeDir } = loadResolvedConfig({
    cwd: ctx.global.cwd,
    configPath: ctx.global.configPath,
  });
  const { db, close } = openLocalDb(homeDir);
  try {
    const storeDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const resolver = createProviderResolver(ctx.io.env, createOsKeychainStore());
    const providerStore = createProviderStore(db, storeDeps);
    const catalogStore = createModelCatalogStore(db, storeDeps);
    const refreshService = createModelRefreshService({
      resolveProvider: resolver.resolveProvider,
      keyFor: resolver.keyFor,
      providerStore,
      catalogStore,
      knownProviderIds: KNOWN_PROVIDER_IDS,
      knownProviders: KNOWN_PROVIDERS,
      now: () => Date.now(),
    });
    return await modelsCommand(args, {
      io: ctx.io,
      global: ctx.global,
      catalog: catalogStore,
      refreshService,
    });
  } finally {
    close();
  }
}

const executeModels: CommandExecutor = (_input, ctx) => withModelsDeps(ctx, { refresh: false });
const executeModelsRefresh: CommandExecutor = (_input, ctx) =>
  withModelsDeps(ctx, { refresh: true });

/** Open the local db + OS keychain for one `provider` invocation, run the core, and always close the db. */
async function withProviderDeps(
  ctx: DispatchContext,
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

/** Build a provider executor for one `ProviderCommandArgs` shape (the subcommand id → its action). */
function providerExecutor(build: (input: CommandInput) => ProviderCommandArgs): CommandExecutor {
  // Extract/validate the args BEFORE opening any db/keychain deps — malformed input fails cleanly without
  // initializing (and then tearing down) dependencies it never reached.
  return (input, ctx) => {
    const args = build(input);
    return withProviderDeps(ctx, (deps) => runProviderCommand(args, deps));
  };
}

// ── the dispatch table ───────────────────────────────────────────────────────

const COMMAND_EXECUTORS: ReadonlyMap<string, CommandExecutor> = new Map<string, CommandExecutor>([
  ['run', executeRun],
  ['chat', executeChat],
  ['chat-resume', executeChatResume],
  ['chat-list', executeChatList],
  ['chat-export', executeChatExport],
  ['create', executeCreate],
  ['export', executeExport],
  ['import', executeImport],
  ['agent.run', executeAgentRun],
  ['gate', executeGate],
  ['gate.list', executeGateList],
  ['list', executeList],
  ['logs', executeLogs],
  ['status', executeStatus],
  ['models', executeModels],
  ['models.refresh', executeModelsRefresh],
  ['provider.list', providerExecutor(() => ({ action: 'list' }))],
  ['provider.add', providerExecutor(buildProviderAddArgs)],
  [
    'provider.set-key',
    providerExecutor((input) => ({ action: 'set-key', name: reqPositional(input, 0, 'name') })),
  ],
  [
    'provider.remove-key',
    providerExecutor((input) => ({ action: 'remove-key', name: reqPositional(input, 0, 'name') })),
  ],
  ['provider.test', providerExecutor(buildProviderTestArgs)],
]);

/** Every manifest-command id that {@link executeCommand} can dispatch (the drift guard ties this to the manifest). */
export const DISPATCHABLE_COMMAND_IDS: readonly string[] = [...COMMAND_EXECUTORS.keys()];

/** Whether `id` maps to a real executor — a surface checks this BEFORE dispatch to print a safe hint on a miss. */
export function isDispatchableId(id: string): boolean {
  return COMMAND_EXECUTORS.has(id);
}

/**
 * Dispatch a command by its manifest id over the uniform {@link CommandInput}. An unknown id is a clean
 * invocation fault (never echoed back — the safe, secret-free path; a surface that wants to print a hint calls
 * {@link isDispatchableId} first). `async`, so every fault (an unknown id, or an arg-extraction `CliError` like a
 * `gate` without a runId) surfaces as a **rejection**, never a synchronous throw — callers only need `await` / `.catch`.
 */
export async function executeCommand(
  id: string,
  input: CommandInput,
  ctx: DispatchContext,
): Promise<ExitCode> {
  const executor = COMMAND_EXECUTORS.get(id);
  if (executor === undefined) {
    throw new CliError('invalid_invocation', 'unknown command.');
  }
  return executor(input, ctx);
}
