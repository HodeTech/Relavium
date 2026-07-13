import { randomUUID } from 'node:crypto';

import { createModelCatalogStore, createProviderStore, type ProviderStore } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { openLocalDb, type OpenedDb } from '../db/open.js';
import { createModelRefreshService } from '../engine/model-refresh.js';
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  createProviderResolver,
  type ProviderResolver,
} from '../engine/providers.js';
import { openHistoryStore } from '../history/open.js';
import { openSessionStore } from '../history/session-open.js';
import { CliError } from '../process/errors.js';
import { type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { selectChatDriver } from '../render/tui/chat-ink.js';
import type { KeychainStore } from '../secrets/keychain.js';
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
import { modelsPricingCommand, type ModelsPricingCommandArgs } from './models-pricing.js';
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

export function buildProviderListArgs(input: CommandInput): ProviderCommandArgs {
  return { action: 'list', verify: boolFlag(input.options['verify']) };
}

export function buildProviderAddArgs(input: CommandInput): ProviderCommandArgs {
  const baseUrl = optString(input.options['baseUrl']);
  const pricingUrl = optString(input.options['pricingUrl']);
  return {
    action: 'add',
    name: reqPositional(input, 0, 'name'),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(pricingUrl === undefined ? {} : { pricingUrl }),
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

/** Parse one USD/Mtok option string → a finite number (invocation-level: shape only; the command core owns the
 *  non-negative + ceiling domain rules). The raw value is NEVER echoed (a defensive no-terminal-injection habit). */
function parseUsdPerMtok(raw: string, flag: string): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value)) {
    throw new CliError(
      'invalid_invocation',
      `${flag} must be a finite number of USD per million tokens.`,
    );
  }
  return value;
}

export function buildModelsPricingArgs(input: CommandInput): ModelsPricingCommandArgs {
  const provider = optString(input.options['provider']);
  if (provider === undefined) {
    throw new CliError('invalid_invocation', 'missing required option --provider <slug>.');
  }
  // `--clear` RETIRES an override (ADR-0071 §5) — the only way back from a price the user regrets. Before it existed
  // there was none: a mispriced model could be corrected but never un-priced, so a user who overrode a catalog model
  // by mistake was stuck with their own number for good. It takes no price flags, and rejects them rather than
  // quietly ignoring half an invocation.
  if (input.options['clear'] === true) {
    for (const flag of ['input', 'output', 'cached'] as const) {
      if (optString(input.options[flag]) !== undefined) {
        throw new CliError(
          'invalid_invocation',
          `--clear removes the price; it takes no --${flag}. Nothing written.`,
        );
      }
    }
    return { model: reqPositional(input, 0, 'model'), provider, clear: true };
  }
  const rawInput = optString(input.options['input']);
  const rawOutput = optString(input.options['output']);
  if (rawInput === undefined) {
    throw new CliError('invalid_invocation', 'missing required option --input <usd-per-mtok>.');
  }
  if (rawOutput === undefined) {
    throw new CliError('invalid_invocation', 'missing required option --output <usd-per-mtok>.');
  }
  const rawCached = optString(input.options['cached']);
  return {
    model: reqPositional(input, 0, 'model'),
    provider,
    inputUsdPerMtok: parseUsdPerMtok(rawInput, '--input'),
    outputUsdPerMtok: parseUsdPerMtok(rawOutput, '--output'),
    ...(rawCached === undefined
      ? {}
      : { cachedInputUsdPerMtok: parseUsdPerMtok(rawCached, '--cached') }),
  };
}

// ── executors (production dep wiring, copied verbatim from the old register* bodies) ──

/**
 * Build a **store-aware** provider resolver (2.5.G S9, [ADR-0065](../../../../docs/decisions/0065-provider-economics-and-extensibility.md) §4):
 * open the durable `history.db` briefly to read the provider registry so a stored **custom `base_url`** rebinds
 * its adapter to the SSRF-validated endpoint, then close it. The custom adapters are built EAGERLY at resolver
 * creation (`applyCustomEndpoints` reads `list()` once), so no db handle is held past this call — a self-contained
 * short-lived read that needs no lifecycle threaded into the command's own db/teardown ordering.
 *
 * The `run`/`chat`/`gate` commands then re-open the same `history.db` for their own stores — a deliberate, PURELY
 * SEQUENTIAL second open (the first handle is fully closed here first, so no WAL/lock race), accepted as the
 * low-risk alternative to threading the db handle through each command's careful teardown. The `models` /
 * `provider` paths avoid it entirely — they build the resolver from the db they already hold (`withModelsDeps` /
 * `withProviderDeps`), and the long-lived Home builds it over its one open handle in the S7 port block.
 */
function storeAwareResolver(
  ctx: DispatchContext,
  keychain: KeychainStore,
): ReturnType<typeof createProviderResolver> {
  const { homeDir } = loadResolvedConfig({
    cwd: ctx.global.cwd,
    configPath: ctx.global.configPath,
  });
  const { db, close } = openLocalDb(homeDir);
  try {
    const providerStore = createProviderStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
    });
    return createProviderResolver(ctx.io.env, keychain, { providerStore });
  } finally {
    close();
  }
}

/** One native keychain accessor, shared by the key resolver (2.C) + the MCP named-secret resolver (2.R §6). */
function keyResolvers(ctx: DispatchContext): {
  providers: ReturnType<typeof createProviderResolver>;
  mcpSecretResolver: ReturnType<typeof createMcpSecretResolver>;
} {
  const keychain = createOsKeychainStore();
  return {
    providers: storeAwareResolver(ctx, keychain),
    mcpSecretResolver: createMcpSecretResolver(ctx.io.env, keychain),
  };
}

/** The store-aware provider resolver alone (a command — like `gate` — that needs keys but not MCP secrets). */
function providerResolver(ctx: DispatchContext): ReturnType<typeof createProviderResolver> {
  return storeAwareResolver(ctx, createOsKeychainStore());
}

const executeRun: CommandExecutor = (input, ctx) =>
  runCommand(buildRunArgs(input), {
    io: ctx.io,
    global: ctx.global,
    openRunStore: openHistoryStore,
    ...keyResolvers(ctx),
  });

const executeChat: CommandExecutor = (input, ctx) =>
  chatCommand(buildChatArgs(input), {
    io: ctx.io,
    global: ctx.global,
    ...keyResolvers(ctx),
    openSessionStore,
    drive: selectChatDriver,
  });

const executeChatResume: CommandExecutor = (input, ctx) =>
  chatResumeCommand(
    { sessionId: reqPositional(input, 0, 'sessionId') },
    {
      io: ctx.io,
      global: ctx.global,
      ...keyResolvers(ctx),
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
    ...keyResolvers(ctx),
  });

const executeGate: CommandExecutor = (input, ctx) =>
  gateCommand(buildGateArgs(input), {
    io: ctx.io,
    global: ctx.global,
    // Production resolves a post-gate agent's key via the OS keychain → env var (2.C), like `run`.
    providers: providerResolver(ctx),
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
 * The lazy `llm_providers`-UUID → provider-slug (e.g. `anthropic`) resolver the `models` list path uses for its
 * `--json` `provider` field + human table. The `id → name` map is built LAZILY on first call and memoized (`??=`):
 * it is read only while RENDERING, which happens AFTER any first-run refresh has upserted its provider rows — so a
 * provider DISCOVERED on this very invocation is captured too. Hoisting the map build ahead of the refresh would
 * silently render a first-run provider's raw UUID instead of its slug. An unmapped uuid falls back to itself
 * (never throws). Extracted (not inlined in {@link withModelsDeps}) so the lazy-after-refresh ordering is unit-tested.
 */
export function createProviderSlugResolver(
  providerStore: Pick<ReturnType<typeof createProviderStore>, 'list'>,
): (uuid: string) => string {
  let slugByUuid: Map<string, string> | undefined;
  return (uuid: string): string => {
    slugByUuid ??= new Map(providerStore.list().map((p): [string, string] => [p.id, p.name]));
    return slugByUuid.get(uuid) ?? uuid;
  };
}

/**
 * The I/O ports {@link withModelsDeps} owns — the local-db opener and the OS-keychain-backed provider resolver
 * factory. Injectable (defaulting to {@link PRODUCTION_MODELS_PORTS}) so a test can drive the whole `models`
 * wiring — including the close-on-fault lifecycle — over an in-memory db + a network-free stub resolver, without
 * touching the real `history.db` or loading the native keychain.
 */
export interface ModelsDbPorts {
  readonly openDb: (homeDir: string) => OpenedDb;
  /** Build the key resolver over the models db — the `providerStore` (from the SAME db) makes it store-aware so a
   *  custom `base_url` lists models over the SSRF-validated hop (2.5.G S9, ADR-0065 §4). A test stub may ignore it. */
  readonly makeResolver: (
    io: CliIo,
    providerStore: Pick<ProviderStore, 'list'>,
  ) => Pick<ProviderResolver, 'resolveProvider' | 'keyFor'>;
}

const PRODUCTION_MODELS_PORTS: ModelsDbPorts = {
  openDb: openLocalDb,
  makeResolver: (io, providerStore) =>
    createProviderResolver(io.env, createOsKeychainStore(), { providerStore }),
};

/**
 * Open the local db + OS keychain for one `models` invocation, wire the S5 refresh service over the S4 catalog
 * store + the S2 `listModels?` seam, run the core, and ALWAYS close the db — even on a thrown fault (2.5.G S5,
 * ADR-0064). The key resolver reads a provider key only inside the refresh (keychain → env); the catalog holds no
 * key. `ports` is injectable for tests; production uses the real db + keychain-backed resolver.
 */
export async function withModelsDeps(
  ctx: DispatchContext,
  args: ModelsCommandArgs,
  ports: ModelsDbPorts = PRODUCTION_MODELS_PORTS,
): Promise<ExitCode> {
  const { homeDir } = loadResolvedConfig({
    cwd: ctx.global.cwd,
    configPath: ctx.global.configPath,
  });
  const { db, close } = ports.openDb(homeDir);
  try {
    const storeDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    const providerStore = createProviderStore(db, storeDeps);
    const resolver = ports.makeResolver(ctx.io, providerStore); // store-aware ⇒ a custom base_url is used (S9)
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
      providerSlug: createProviderSlugResolver(providerStore),
    });
  } finally {
    close();
  }
}

const executeModels: CommandExecutor = (_input, ctx) => withModelsDeps(ctx, { refresh: false });
const executeModelsRefresh: CommandExecutor = (_input, ctx) =>
  withModelsDeps(ctx, { refresh: true });

/**
 * `models pricing <model>` (2.5.G S10, ADR-0065) — open the local db, build the catalog + provider stores over it,
 * capture the user price, and ALWAYS close the db. No keychain / resolver / refresh service is needed (a pure local
 * write), so this is a lighter path than {@link withModelsDeps}. Args are parsed FIRST (a bad flag fails exit-2
 * before the db opens); the core is injected in unit tests directly (never touching `~/.relavium/history.db`).
 */
const executeModelsPricing: CommandExecutor = (input, ctx) => {
  const args = buildModelsPricingArgs(input); // a bad/absent flag is an invocation fault before any db work
  const { homeDir } = loadResolvedConfig({
    cwd: ctx.global.cwd,
    configPath: ctx.global.configPath,
  });
  const { db, close } = openLocalDb(homeDir);
  try {
    const storeDeps = { uuid: () => randomUUID(), now: () => Date.now() };
    return Promise.resolve(
      modelsPricingCommand(args, {
        io: ctx.io,
        global: ctx.global,
        catalog: createModelCatalogStore(db, storeDeps),
        providers: createProviderStore(db, storeDeps),
      }),
    );
  } finally {
    close();
  }
};

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
    const store = createProviderStore(db, { uuid: () => randomUUID(), now: () => Date.now() });
    const deps: ProviderCommandDeps = {
      io: ctx.io,
      store,
      keychain,
      // Store-aware so `provider test` pings a custom `base_url` provider at its CUSTOM endpoint (2.5.G S9).
      resolver: createProviderResolver(ctx.io.env, keychain, { providerStore: store }),
      readSecret: readSecretFromStdin,
      global: ctx.global, // for `provider list --json` (2.5.G S11, ADR-0049)
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
  ['models.pricing', executeModelsPricing],
  ['provider.list', providerExecutor(buildProviderListArgs)],
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
