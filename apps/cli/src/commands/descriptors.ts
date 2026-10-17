import { FS_ROOT_LIMITS } from '@relavium/shared/fs-root-limits';

import { CliError } from '../process/cli-error.js';
import type { CommandManifestEntry } from './manifest.js';

export type DescriptorValueType = 'string' | 'number' | 'boolean';
export interface PositionalDescriptor {
  readonly name: string;
  readonly binding: string;
  readonly type: DescriptorValueType;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly description: string;
}
export interface OptionDescriptor {
  readonly binding: string;
  readonly spellings: readonly string[];
  readonly deprecatedSpellings: readonly string[];
  readonly arity: 'none' | 'required' | 'optional';
  readonly placeholder?: string;
  readonly type: DescriptorValueType;
  readonly repetition: 'single' | 'repeatable' | 'variadic';
  readonly negated: boolean;
  readonly required: boolean;
  readonly description: string;
  readonly default?: string | boolean | readonly string[];
  readonly conflicts: readonly string[];
}
interface AuthoredOption extends OptionDescriptor {
  /** Internal projections only; neither field is serialized in CLI discovery. */
  readonly compatibility?: boolean;
  readonly model?: boolean;
}
export interface CommandDescriptor {
  readonly path: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly effect: 'read' | 'write' | 'destructive';
  readonly availability: 'implemented' | 'not_implemented';
  readonly aliases: readonly { readonly path: readonly string[]; readonly deprecated: boolean }[];
  readonly positionals: readonly PositionalDescriptor[];
  readonly options: readonly AuthoredOption[];
  readonly executorId?: string;
  /** Existing model order is compatible even where current CLI help orders groups differently. */
  readonly legacyModelOrder?: number;
  readonly modeScope?: readonly ('ask' | 'plan' | 'accept-edits' | 'auto')[];
  readonly allowExcessArguments?: boolean;
  readonly opaqueParserHint?: string;
  readonly requiredSubcommand?: string;
  readonly landsIn?: string;
}
export interface GlobalOptionDescriptor extends OptionDescriptor {
  readonly scope: 'position-independent';
  readonly owner: 'extractor' | 'commander';
}

/** Trusted authored JSON data only, not a normalizer of untrusted request/result graphs. */
function freezeData<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** Single authored authority. Future canonical aliases/options are staged until Step 10 integration. */
export const COMMAND_DESCRIPTORS: readonly CommandDescriptor[] = freezeData([
  {
    path: ['run'],
    label: 'Run workflow',
    description: 'Execute a workflow (path or id), streaming progress.',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'workflow',
        binding: 'workflow',
        type: 'string',
        required: true,
        variadic: false,
        description: 'workflow path or id',
      },
    ],
    options: [
      {
        binding: 'input',
        spellings: ['--input'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'variadic',
        negated: false,
        required: false,
        description: 'a workflow input (repeatable)',
        conflicts: [],
        placeholder: 'key=value',
      },
      {
        binding: 'secretInputsStdin',
        spellings: ['--secret-inputs-stdin'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'read declared secret inputs from non-TTY stdin',
        conflicts: [],
      },
      {
        binding: 'allowMcpStdio',
        spellings: ['--allow-mcp-stdio'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'variadic',
        negated: false,
        required: false,
        description:
          'authorize a stdio MCP server by its consent digest for this invocation (repeatable)',
        conflicts: [],
        placeholder: 'digest',
      },
    ],
    executorId: 'run',
    legacyModelOrder: 0,
    opaqueParserHint: 'error: invalid run arguments; use relavium run --help.',
    allowExcessArguments: false,
  },
  {
    path: ['chat'],
    label: 'Start chat',
    description: 'Start an interactive agent chat session (REPL).',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [
      {
        binding: 'agent',
        spellings: ['--agent'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'bind a specific agent (.agent.yaml path or .relavium/ id)',
        conflicts: [],
        placeholder: 'ref',
      },
    ],
    executorId: 'chat',
    legacyModelOrder: 1,
  },
  {
    path: ['chat', 'resume'],
    label: 'Resume chat',
    description: 'Reload a persisted session from history.db and continue the conversation.',
    effect: 'write',
    availability: 'implemented',
    aliases: [
      {
        path: ['chat-resume'],
        deprecated: true,
      },
    ],
    positionals: [
      {
        name: 'sessionId',
        binding: 'sessionId',
        type: 'string',
        required: true,
        variadic: false,
        description: 'the session to resume',
      },
    ],
    options: [],
    executorId: 'chat-resume',
    legacyModelOrder: 2,
  },
  {
    path: ['chat', 'list'],
    label: 'List sessions',
    description: 'List past agent sessions (id, agent, title, last activity).',
    effect: 'read',
    availability: 'implemented',
    aliases: [
      {
        path: ['chat-list'],
        deprecated: true,
      },
    ],
    positionals: [],
    options: [],
    executorId: 'chat-list',
    legacyModelOrder: 3,
  },
  {
    path: ['chat', 'export'],
    label: 'Export session',
    description: 'Export a session to a .relavium.yaml scaffold for review (ADR-0026).',
    effect: 'write',
    availability: 'implemented',
    aliases: [
      {
        path: ['chat-export'],
        deprecated: true,
      },
    ],
    positionals: [
      {
        name: 'sessionId',
        binding: 'sessionId',
        type: 'string',
        required: true,
        variadic: false,
        description: 'the session to export',
      },
    ],
    options: [
      {
        binding: 'out',
        spellings: ['--out'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'write the scaffold here instead of <id>.relavium.yaml',
        conflicts: [],
        placeholder: 'path',
      },
      {
        binding: 'force',
        spellings: ['--force'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'overwrite an existing file at the target path',
        conflicts: [],
      },
    ],
    executorId: 'chat-export',
    legacyModelOrder: 4,
  },
  {
    path: ['create'],
    label: 'Create (scaffold)',
    description: 'Scaffold a new agent or workflow via an interactive wizard.',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [
      {
        binding: 'force',
        spellings: ['--force'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'overwrite an existing project entry with the same id',
        conflicts: [],
      },
    ],
    executorId: 'create',
    legacyModelOrder: 5,
  },
  {
    path: ['export'],
    label: 'Export YAML',
    description:
      'Export a workflow/agent to a portable YAML (secret references stay placeholdered).',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'id',
        binding: 'id',
        type: 'string',
        required: true,
        variadic: false,
        description: 'workflow or agent id to export',
      },
    ],
    options: [
      {
        binding: 'out',
        spellings: ['--out'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'write the copy here instead of <id>.<suffix> in cwd',
        conflicts: [],
        placeholder: 'path',
      },
      {
        binding: 'force',
        spellings: ['--force'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'overwrite an existing file at the target path',
        conflicts: [],
      },
    ],
    executorId: 'export',
    legacyModelOrder: 6,
  },
  {
    path: ['import'],
    label: 'Import YAML',
    description:
      'Import an external workflow/agent YAML into the project (validated, deduplicated).',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'path',
        binding: 'path',
        type: 'string',
        required: true,
        variadic: false,
        description: 'path to the .relavium.yaml / .agent.yaml file',
      },
    ],
    options: [
      {
        binding: 'force',
        spellings: ['--force'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'overwrite an existing project entry with the same id',
        conflicts: [],
      },
    ],
    executorId: 'import',
    legacyModelOrder: 7,
  },
  {
    path: ['agent'],
    label: 'Agent',
    description: 'Manage and run agents.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [],
    requiredSubcommand: 'run',
  },
  {
    path: ['agent', 'run'],
    label: 'Run agent (one-shot)',
    description:
      'Run a single agent one-shot (prompt on stdin); --fixture replays a recorded cassette.',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'agent',
        binding: 'agent',
        type: 'string',
        required: true,
        variadic: false,
        description: 'agent .agent.yaml path or .relavium/ id',
      },
    ],
    options: [
      {
        binding: 'input',
        spellings: ['--input'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'variadic',
        negated: false,
        required: false,
        description: 'a session {{ctx.*}} variable (repeatable)',
        conflicts: [],
        placeholder: 'key=value',
      },
      {
        binding: 'fixture',
        spellings: ['--fixture'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'replay a recorded LLM cassette (deterministic, offline)',
        conflicts: [],
        placeholder: 'path',
      },
      {
        binding: 'allowMcpStdio',
        spellings: ['--allow-mcp-stdio'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'variadic',
        negated: false,
        required: false,
        description:
          'authorize a stdio MCP server by its consent digest for this invocation (repeatable)',
        conflicts: [],
        placeholder: 'digest',
      },
    ],
    executorId: 'agent.run',
    legacyModelOrder: 8,
  },
  {
    path: ['gate'],
    label: 'Resolve gate',
    description: 'Resolve a pending human gate (approve / reject / input).',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'runId',
        binding: 'runId',
        type: 'string',
        required: false,
        variadic: false,
        description: 'the paused run (omit only with the list subcommand)',
      },
    ],
    options: [
      {
        binding: 'approve',
        spellings: ['--approve'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'approve the gate',
        conflicts: [],
      },
      {
        binding: 'reject',
        spellings: ['--reject'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'reject the gate',
        conflicts: [],
      },
      {
        binding: 'comment',
        spellings: ['--comment'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'a decision comment (with --approve / --reject)',
        conflicts: [],
        placeholder: 'text',
      },
      {
        binding: 'input',
        spellings: ['--input'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'provide input for a gate_type=input gate (JSON, else a raw string)',
        conflicts: [],
        placeholder: 'value',
      },
      {
        binding: 'gate',
        spellings: ['--gate'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'which pending gate to resolve (required when more than one is pending)',
        conflicts: [],
        placeholder: 'gateId',
      },
      {
        binding: 'secretStdin',
        spellings: ['--secret-stdin'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description:
          "read the run's secret inputs from stdin as name=value lines (never passed as arguments)",
        conflicts: [],
      },
      {
        binding: 'allowMcpStdio',
        spellings: ['--allow-mcp-stdio'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'variadic',
        negated: false,
        required: false,
        description:
          'authorize a stdio MCP server by its consent digest for this invocation (repeatable)',
        conflicts: [],
        placeholder: 'digest',
      },
    ],
    executorId: 'gate',
    legacyModelOrder: 9,
  },
  {
    path: ['gate', 'list'],
    label: 'List gates',
    description: 'List pending human gates (all paused runs, or one run).',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'runId',
        binding: 'runId',
        type: 'string',
        required: false,
        variadic: false,
        description: 'a single run to inspect (omit ⇒ all paused runs)',
      },
    ],
    options: [],
    executorId: 'gate.list',
    legacyModelOrder: 11,
  },
  {
    path: ['budget'],
    label: 'Budget',
    description: 'Resolve recorded budget authorization.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [],
  },
  {
    path: ['budget', 'resume'],
    label: 'Resolve budget gate',
    description: 'Approve the exact frozen microcents or reject a budget gate.',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'runId',
        binding: 'runId',
        type: 'string',
        required: true,
        variadic: false,
        description: 'the budget-paused run',
      },
    ],
    options: [
      {
        binding: 'approveAmount',
        spellings: ['--approve-amount'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'approve exactly the recorded frozen amount (including zero)',
        conflicts: [],
        placeholder: 'microcents',
      },
      {
        binding: 'abort',
        spellings: ['--abort'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'reject the budget gate without provider or tool execution',
        conflicts: [],
      },
      {
        binding: 'gate',
        spellings: ['--gate'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'which budget gate to resolve when multiple are pending',
        conflicts: [],
        placeholder: 'gateId',
      },
      {
        binding: 'secretStdin',
        spellings: ['--secret-stdin'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description:
          "read the run's secret inputs from stdin as name=value lines (never passed as arguments)",
        conflicts: [],
      },
      {
        binding: 'allowMcpStdio',
        spellings: ['--allow-mcp-stdio'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'variadic',
        negated: false,
        required: false,
        description:
          'authorize a stdio MCP server by its consent digest for this invocation (repeatable)',
        conflicts: [],
        placeholder: 'digest',
      },
    ],
    executorId: 'budget.resume',
    legacyModelOrder: 10,
  },
  {
    path: ['models'],
    label: 'List models',
    description: 'List the cached model catalog (refreshes on first run if empty).',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [],
    executorId: 'models',
    legacyModelOrder: 15,
  },
  {
    path: ['models', 'refresh'],
    label: 'Refresh models',
    description:
      "Re-fetch what we know about models: each connected provider's live list, and the models.dev catalog.",
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [
      {
        binding: 'providers',
        spellings: ['--providers'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: "availability only — each connected provider's live model list",
        conflicts: [],
      },
      {
        binding: 'catalog',
        spellings: ['--catalog'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'metadata only — prices, ceilings and reasoning tiers from models.dev',
        conflicts: [],
      },
    ],
    executorId: 'models.refresh',
    legacyModelOrder: 16,
  },
  {
    path: ['models', 'pricing'],
    label: 'Set model pricing',
    description:
      'Set your own price for a model — it overrides the catalog (you hold the invoice). --clear removes it.',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'model',
        binding: 'model',
        type: 'string',
        required: true,
        variadic: false,
        description: 'the model id to price',
      },
    ],
    options: [
      {
        binding: 'provider',
        spellings: ['--provider'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: true,
        description: 'the provider that serves the model (must be registered)',
        conflicts: [],
        placeholder: 'slug',
      },
      {
        binding: 'input',
        spellings: ['--input-price'],
        deprecatedSpellings: ['--input'],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description:
          'input (prompt) price, USD per million tokens — required WITH --output when either is given; omit both to price only media',
        conflicts: [],
        placeholder: 'usd-per-mtok',
      },
      {
        binding: 'output',
        spellings: ['--output-price'],
        deprecatedSpellings: ['--output'],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description:
          'output (completion) price, USD per million tokens — required WITH --input when either is given; omit both to price only media',
        conflicts: [],
        placeholder: 'usd-per-mtok',
      },
      {
        binding: 'cached',
        spellings: ['--cached'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description:
          "cache-read price, USD per million tokens; omitted ⇒ the catalog's cache discount, applied to your input rate",
        conflicts: [],
        placeholder: 'usd-per-mtok',
      },
      {
        binding: 'image',
        spellings: ['--image'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'image-output price, USD per image',
        conflicts: [],
        placeholder: 'usd-per-image',
      },
      {
        binding: 'audio',
        spellings: ['--audio'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'audio-output price, USD per second',
        conflicts: [],
        placeholder: 'usd-per-second',
      },
      {
        binding: 'video',
        spellings: ['--video'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'video-output price, USD per second',
        conflicts: [],
        placeholder: 'usd-per-second',
      },
      {
        binding: 'clear',
        spellings: ['--clear'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: "remove your price for this model — it falls back to the catalog's",
        conflicts: [],
      },
    ],
    executorId: 'models.pricing',
    legacyModelOrder: 17,
  },
  {
    path: ['provider'],
    label: 'Provider',
    description: 'Manage providers and API keys in the OS keychain.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [],
  },
  {
    path: ['provider', 'list'],
    label: 'List providers',
    description: 'List registered providers and whether a key is set.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [
      {
        binding: 'verify',
        spellings: ['--verify'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'additionally run a live key-verification probe per provider',
        conflicts: [],
      },
    ],
    executorId: 'provider.list',
    legacyModelOrder: 18,
  },
  {
    path: ['provider', 'add'],
    label: 'Add provider',
    description: 'Register a provider.',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'name',
        binding: 'name',
        type: 'string',
        required: true,
        variadic: false,
        description: 'provider name (e.g. anthropic)',
      },
    ],
    options: [
      {
        binding: 'baseUrl',
        spellings: ['--base-url'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'override the provider base URL',
        conflicts: [],
        placeholder: 'url',
      },
      {
        binding: 'pricingUrl',
        spellings: ['--pricing-url'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'override the pricing reference page (where you find model prices)',
        conflicts: [],
        placeholder: 'url',
      },
    ],
    executorId: 'provider.add',
    legacyModelOrder: 19,
  },
  {
    path: ['provider', 'set-key'],
    label: 'Set provider key',
    description: 'Store a provider API key in the OS keychain (the key is read from stdin).',
    effect: 'write',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'name',
        binding: 'name',
        type: 'string',
        required: true,
        variadic: false,
        description: 'provider name (e.g. anthropic)',
      },
    ],
    options: [],
    executorId: 'provider.set-key',
    legacyModelOrder: 20,
  },
  {
    path: ['provider', 'remove-key'],
    label: 'Remove provider key',
    description: 'Remove a provider API key from the OS keychain.',
    effect: 'destructive',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'name',
        binding: 'name',
        type: 'string',
        required: true,
        variadic: false,
        description: 'provider name (e.g. anthropic)',
      },
    ],
    options: [
      {
        binding: 'force',
        spellings: ['--force'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'remove the key without an interactive confirmation',
        conflicts: [],
        compatibility: false,
        model: false,
      },
    ],
    executorId: 'provider.remove-key',
    legacyModelOrder: 22,
  },
  {
    path: ['provider', 'test'],
    label: 'Test provider key',
    description: 'Verify a provider key with a minimal live request.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'name',
        binding: 'name',
        type: 'string',
        required: true,
        variadic: false,
        description: 'provider name (e.g. anthropic)',
      },
    ],
    options: [
      {
        binding: 'model',
        spellings: ['--model'],
        deprecatedSpellings: [],
        arity: 'required',
        type: 'string',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'model to test with (defaults to a cheap known model)',
        conflicts: [],
        placeholder: 'id',
      },
    ],
    executorId: 'provider.test',
    legacyModelOrder: 23,
  },
  {
    path: ['media'],
    label: 'Media',
    description: 'Manage local media storage.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [],
  },
  {
    path: ['media', 'prune-temporaries'],
    label: 'Prune legacy media temporaries',
    description: 'Remove legacy temporary media after all old producers are stopped.',
    effect: 'destructive',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [
      {
        binding: 'legacyOffline',
        spellings: ['--legacy-offline'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'acknowledge that all old media producers are stopped',
        conflicts: [],
      },
      {
        binding: 'force',
        spellings: ['--force'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'authorize legacy temporary media deletion',
        conflicts: [],
      },
    ],
    executorId: 'media.prune-temporaries',
    legacyModelOrder: 21,
    opaqueParserHint: 'error: invalid media maintenance arguments.',
    allowExcessArguments: false,
  },
  {
    path: ['list'],
    label: 'List workflows',
    description: 'List discovered workflows (or, with --agents, agents) in the current project.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [
      {
        binding: 'agents',
        spellings: ['--agents'],
        deprecatedSpellings: [],
        arity: 'none',
        type: 'boolean',
        repetition: 'single',
        negated: false,
        required: false,
        description: 'list agents instead of workflows',
        conflicts: [],
      },
    ],
    executorId: 'list',
    legacyModelOrder: 12,
  },
  {
    path: ['logs'],
    label: 'Show run logs',
    description: 'Print the persisted event stream for a past run.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [
      {
        name: 'runId',
        binding: 'runId',
        type: 'string',
        required: true,
        variadic: false,
        description: 'the run to print',
      },
    ],
    options: [],
    executorId: 'logs',
    legacyModelOrder: 13,
  },
  {
    path: ['status'],
    label: 'Show status',
    description: 'Show active/paused runs and their per-node status.',
    effect: 'read',
    availability: 'implemented',
    aliases: [],
    positionals: [],
    options: [],
    executorId: 'status',
    legacyModelOrder: 14,
  },
  {
    path: ['init'],
    label: 'Init',
    description: 'Initialize a .relavium/ directory in the current project.',
    effect: 'read',
    availability: 'not_implemented',
    aliases: [],
    positionals: [],
    options: [],
    landsIn: 'a later workstream',
  },
] satisfies readonly CommandDescriptor[]);

function globalOption(
  binding: string,
  spellings: readonly string[],
  description: string,
  details: Partial<GlobalOptionDescriptor> = {},
): GlobalOptionDescriptor {
  return {
    binding,
    spellings,
    description,
    deprecatedSpellings: [],
    arity: 'none',
    type: 'boolean',
    repetition: 'single',
    negated: false,
    required: false,
    conflicts: [],
    scope: 'position-independent',
    owner: 'extractor',
    ...details,
  };
}

export const GLOBAL_OPTION_DESCRIPTORS: readonly GlobalOptionDescriptor[] = freezeData([
  globalOption('json', ['--json'], 'emit machine-readable NDJSON output (disables the TUI)'),
  globalOption('color', ['--color'], 'force colored output on'),
  globalOption('color', ['--no-color'], 'disable colored output', { negated: true }),
  globalOption('cwd', ['--cwd'], 'run as if started in <dir>', {
    arity: 'required',
    placeholder: 'dir',
    type: 'string',
  }),
  globalOption('config', ['--config'], 'use an explicit config file', {
    arity: 'required',
    placeholder: 'path',
    type: 'string',
  }),
  globalOption(
    'allowFsRoots',
    ['--allow-fs-root'],
    `grant a chat/Home/agent-run root (repeatable, max ${FS_ROOT_LIMITS.count})`,
    {
      arity: 'required',
      placeholder: 'absolute-directory',
      type: 'string',
      repetition: 'repeatable',
    },
  ),
  globalOption(
    'noAltScreen',
    ['--no-alt-screen'],
    'keep the inline renderer (no full-screen alt screen)',
  ),
  globalOption(
    'noMouse',
    ['--no-mouse'],
    'disable mouse reporting (restores native click-drag selection)',
  ),
  globalOption('verbose', ['-v', '--verbose'], 'print verbose diagnostics to stderr', {
    conflicts: ['quiet'],
  }),
  globalOption('quiet', ['-q', '--quiet'], 'suppress non-essential output', {
    conflicts: ['verbose'],
  }),
  globalOption('help', ['-h', '--help'], 'display help for command', { owner: 'commander' }),
  globalOption('version', ['-V', '--version'], 'output the version number', { owner: 'commander' }),
]);

const globalsBySpelling = new Map(
  GLOBAL_OPTION_DESCRIPTORS.flatMap((option) =>
    option.spellings.map((spelling) => [spelling, option] as const),
  ),
);
export function globalOptionForSpelling(spelling: string): GlobalOptionDescriptor | undefined {
  return globalsBySpelling.get(spelling);
}

export function compatibilityPath(descriptor: CommandDescriptor): readonly string[] {
  if (descriptor.executorId === undefined) return descriptor.path;
  const previous = descriptor.executorId.split('.');
  if (samePath(previous, descriptor.path)) return descriptor.path;
  const alias = descriptor.aliases.find((candidate) => samePath(previous, candidate.path));
  if (alias === undefined) throw new CliError('cli_internal', '');
  return alias.path;
}

export function compatibilityOptions(descriptor: CommandDescriptor): readonly OptionDescriptor[] {
  return descriptor.options
    .filter((option) => option.compatibility !== false)
    .map((option) => ({
      ...option,
      spellings:
        option.deprecatedSpellings.length > 0 ? option.deprecatedSpellings : option.spellings,
    }));
}

export function legacyManifestEntries(): CommandManifestEntry[] {
  return COMMAND_DESCRIPTORS.filter((entry) => entry.executorId !== undefined)
    .toSorted((a, b) => (a.legacyModelOrder ?? 0) - (b.legacyModelOrder ?? 0))
    .map((entry) => {
      if (entry.executorId === undefined) throw new CliError('cli_internal', '');
      const args = [
        ...entry.positionals.map((arg) => ({
          name: arg.binding,
          type: arg.type,
          ...(arg.required ? { required: true } : {}),
          description: arg.description,
        })),
        ...entry.options
          .filter((arg) => arg.model !== false)
          .map((arg) => ({
            name: arg.binding,
            type: arg.type,
            ...(arg.required ? { required: true } : {}),
            description: arg.description,
          })),
      ];
      return {
        id: entry.executorId,
        label: entry.label,
        description: entry.description,
        ...(args.length > 0 ? { args } : {}),
        effect: entry.effect,
        ...(entry.modeScope === undefined ? {} : { modeScope: [...entry.modeScope] }),
      };
    });
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

export function assertDescriptorRegistry(entries: readonly CommandDescriptor[]): void {
  const paths = new Set<string>();
  const executors = new Set<string>();
  const modelOrder = new Set<number>();
  for (const entry of entries) {
    for (const path of [entry.path, ...entry.aliases.map((alias) => alias.path)]) {
      const key = JSON.stringify(path);
      if (path.length === 0 || path.some((part) => part.length === 0) || paths.has(key))
        throw new CliError('cli_internal', '');
      paths.add(key);
    }
    if (entry.executorId !== undefined) {
      if (
        entry.availability !== 'implemented' ||
        executors.has(entry.executorId) ||
        entry.legacyModelOrder === undefined ||
        modelOrder.has(entry.legacyModelOrder)
      )
        throw new CliError('cli_internal', '');
      executors.add(entry.executorId);
      modelOrder.add(entry.legacyModelOrder);
    }
    const bindings = new Set<string>();
    const spellings = new Set<string>();
    for (const positional of entry.positionals) {
      if (bindings.has(positional.binding)) throw new CliError('cli_internal', '');
      bindings.add(positional.binding);
    }
    for (const option of entry.options) {
      if (bindings.has(option.binding)) throw new CliError('cli_internal', '');
      bindings.add(option.binding);
      for (const spelling of [...option.spellings, ...option.deprecatedSpellings]) {
        if (spellings.has(spelling)) throw new CliError('cli_internal', '');
        spellings.add(spelling);
      }
    }
  }
}
assertDescriptorRegistry(COMMAND_DESCRIPTORS);
