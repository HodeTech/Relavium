import { z } from 'zod';

/**
 * The **command manifest** ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C) — one canonical, **alias-free** description of every **shell** command, the single source the shell
 * surfaces derive from: the `commander` parser, `relavium --help --json`, and the `executeCommand` dispatch
 * table ([dispatch.ts](dispatch.ts)). Because they read this one list, they can never disagree. Canonically
 * homed in [commands.md](../../../../docs/reference/cli/commands.md); this module is its runtime form (a CLI-only
 * contract — apps/cli, not `@relavium/shared`).
 *
 * The **in-REPL** `/` palette + slash commands are a SEPARATE, curated registry ([repl-commands.ts](repl-commands.ts),
 * `REPL_COMMANDS` — see the ADR-0056 amendment): a REPL command runs over the live session's lifecycle, not a
 * `CommandInput`, and the heavy shell commands here are never run from inside a chat. The {@link manifest.test.ts}
 * drift guard asserts every real `commander` command has a matching manifest entry (so the shell surfaces cannot diverge).
 */

/** A single command argument the manifest advertises — a positional or a (possibly repeatable) option value. */
export const CommandArgSchema = z
  .object({
    /**
     * The argument / option **key as it appears in `CommandInput.options`** — the camelCase form commander
     * derives via `option.attributeName()` (`workflow`, `agent`, `baseUrl`), never the kebab CLI flag
     * (`--base-url`) and never with leading dashes. A slash/palette surface builds `CommandInput` against this key.
     */
    name: z.string().min(1),
    type: z.enum(['string', 'number', 'boolean']),
    /** A required positional; omit ⇒ optional (an option or an optional positional). */
    required: z.boolean().optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

/**
 * A command's **effect** — a forward-looking annotation for agent discoverability and (later) approval gating.
 * `read` never mutates; `write` creates/modifies; `destructive` irreversibly removes. The enum ships now so the
 * manifest shape is stable, but **enforcement** (approval-gating a `destructive` entry) is owned by
 * [ADR-0057](../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md) (workstream 2.5.E); 2.5.C
 * only records the annotation.
 */
export const CommandEffectSchema = z.enum(['read', 'write', 'destructive']);

/**
 * A chat **mode** a command is available in. The mode values + semantics (`ask` / `plan` / `accept-edits` /
 * `auto`) are defined in [ADR-0057](../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)
 * (2.5.E); the field ships now (omit ⇒ available in **all** modes) so the manifest schema is stable before the
 * modes exist.
 */
export const ChatModeSchema = z.enum(['ask', 'plan', 'accept-edits', 'auto']);

/** One command-manifest entry. The set is deliberately small and alias-free — every entry is canonical. */
export const CommandManifestEntrySchema = z
  .object({
    /** Stable id; a subcommand is dotted (`provider.set-key`, `agent.run`, `gate.list`). */
    id: z.string().min(1),
    /** A short human label for the palette (`Run workflow`, `Set provider key`). */
    label: z.string().min(1),
    /** The one-line help text — must match the `commander` `.description()` so `--help --json` stays consistent. */
    description: z.string().min(1),
    args: z.array(CommandArgSchema).optional(),
    effect: CommandEffectSchema,
    modeScope: z.array(ChatModeSchema).optional(),
  })
  .strict();

export type CommandArg = z.infer<typeof CommandArgSchema>;
export type CommandEffect = z.infer<typeof CommandEffectSchema>;
export type ChatMode = z.infer<typeof ChatModeSchema>;
export type CommandManifestEntry = z.infer<typeof CommandManifestEntrySchema>;

/** Validate a raw entry list at module load (fail loud) and reject duplicate ids — the contract's safety net. */
const CommandManifestSchema = z.array(CommandManifestEntrySchema).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate manifest id '${entry.id}'`,
        path: [index, 'id'],
      });
    }
    seen.add(entry.id);
  }
});

/**
 * The authored entries (pre-validation). Descriptions are copied verbatim from the `commander` registrations in
 * [specs.ts](specs.ts) so the drift guard ties them together. `provider.remove-key` is the one `destructive`
 * entry — it irreversibly removes a stored credential.
 */
const ENTRIES: readonly CommandManifestEntry[] = [
  {
    id: 'run',
    label: 'Run workflow',
    description: 'Execute a workflow (path or id), streaming progress.',
    args: [
      { name: 'workflow', type: 'string', required: true, description: 'workflow path or id' },
      { name: 'input', type: 'string', description: 'a workflow input (repeatable)' },
    ],
    effect: 'write',
  },
  {
    id: 'chat',
    label: 'Start chat',
    description: 'Start an interactive agent chat session (REPL).',
    args: [
      {
        name: 'agent',
        type: 'string',
        description: 'bind a specific agent (.agent.yaml path or .relavium/ id)',
      },
    ],
    effect: 'write',
  },
  {
    id: 'chat-resume',
    label: 'Resume chat',
    description: 'Reload a persisted session from history.db and continue the conversation.',
    args: [
      { name: 'sessionId', type: 'string', required: true, description: 'the session to resume' },
    ],
    effect: 'write',
  },
  {
    id: 'chat-list',
    label: 'List sessions',
    description: 'List past agent sessions (id, agent, title, last activity).',
    effect: 'read',
  },
  {
    id: 'chat-export',
    label: 'Export session',
    description: 'Export a session to a .relavium.yaml scaffold for review (ADR-0026).',
    args: [
      { name: 'sessionId', type: 'string', required: true, description: 'the session to export' },
      {
        name: 'out',
        type: 'string',
        description: 'write the scaffold here instead of <id>.relavium.yaml',
      },
      {
        name: 'force',
        type: 'boolean',
        description: 'overwrite an existing file at the target path',
      },
    ],
    effect: 'write',
  },
  {
    id: 'create',
    label: 'Create (scaffold)',
    description: 'Scaffold a new agent or workflow via an interactive wizard.',
    args: [
      {
        name: 'force',
        type: 'boolean',
        description: 'overwrite an existing project entry with the same id',
      },
    ],
    effect: 'write',
  },
  {
    id: 'export',
    label: 'Export YAML',
    description:
      'Export a workflow/agent to a portable YAML (secret references stay placeholdered).',
    args: [
      { name: 'id', type: 'string', required: true, description: 'workflow or agent id to export' },
      {
        name: 'out',
        type: 'string',
        description: 'write the copy here instead of <id>.<suffix> in cwd',
      },
      {
        name: 'force',
        type: 'boolean',
        description: 'overwrite an existing file at the target path',
      },
    ],
    effect: 'write',
  },
  {
    id: 'import',
    label: 'Import YAML',
    description:
      'Import an external workflow/agent YAML into the project (validated, deduplicated).',
    args: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'path to the .relavium.yaml / .agent.yaml file',
      },
      {
        name: 'force',
        type: 'boolean',
        description: 'overwrite an existing project entry with the same id',
      },
    ],
    effect: 'write',
  },
  {
    id: 'agent.run',
    label: 'Run agent (one-shot)',
    description:
      'Run a single agent one-shot (prompt on stdin); --fixture replays a recorded cassette.',
    args: [
      {
        name: 'agent',
        type: 'string',
        required: true,
        description: 'agent .agent.yaml path or .relavium/ id',
      },
      { name: 'input', type: 'string', description: 'a session {{ctx.*}} variable (repeatable)' },
      {
        name: 'fixture',
        type: 'string',
        description: 'replay a recorded LLM cassette (deterministic, offline)',
      },
    ],
    effect: 'write',
  },
  {
    id: 'gate',
    label: 'Resolve gate',
    description: 'Resolve a pending human gate (approve / reject / input).',
    args: [
      {
        name: 'runId',
        type: 'string',
        description: 'the paused run (omit only with the list subcommand)',
      },
      { name: 'approve', type: 'boolean', description: 'approve the gate' },
      { name: 'reject', type: 'boolean', description: 'reject the gate' },
      {
        name: 'comment',
        type: 'string',
        description: 'a decision comment (with --approve / --reject)',
      },
      {
        name: 'input',
        type: 'string',
        description: 'provide input for a gate_type=input gate (JSON, else a raw string)',
      },
      {
        name: 'gate',
        type: 'string',
        description: 'which pending gate to resolve (required when more than one is pending)',
      },
    ],
    effect: 'write',
  },
  {
    id: 'gate.list',
    label: 'List gates',
    description: 'List pending human gates (all paused runs, or one run).',
    args: [
      {
        name: 'runId',
        type: 'string',
        description: 'a single run to inspect (omit ⇒ all paused runs)',
      },
    ],
    effect: 'read',
  },
  {
    id: 'list',
    label: 'List workflows',
    description: 'List discovered workflows (or, with --agents, agents) in the current project.',
    args: [{ name: 'agents', type: 'boolean', description: 'list agents instead of workflows' }],
    effect: 'read',
  },
  {
    id: 'logs',
    label: 'Show run logs',
    description: 'Print the persisted event stream for a past run.',
    args: [{ name: 'runId', type: 'string', required: true, description: 'the run to print' }],
    effect: 'read',
  },
  {
    id: 'status',
    label: 'Show status',
    description: 'Show active/paused runs and their per-node status.',
    effect: 'read',
  },
  {
    id: 'models',
    label: 'List models',
    description: 'List the cached model catalog (refreshes on first run if empty).',
    effect: 'read',
  },
  {
    id: 'models.refresh',
    label: 'Refresh models',
    description: "Re-fetch each connected provider's live model list into the local cache.",
    effect: 'write',
  },
  {
    id: 'models.pricing',
    label: 'Set model pricing',
    description:
      'Set a user price for a model the registry does not know (custom / new provider models).',
    args: [
      { name: 'model', type: 'string', required: true, description: 'the model id to price' },
      {
        name: 'provider',
        type: 'string',
        required: true,
        description: 'the provider that serves the model (must be registered)',
      },
      {
        name: 'input',
        type: 'string',
        required: true,
        description: 'input (prompt) price, USD per million tokens',
      },
      {
        name: 'output',
        type: 'string',
        required: true,
        description: 'output (completion) price, USD per million tokens',
      },
      {
        name: 'cached',
        type: 'string',
        description: 'cache-read price, USD per million tokens (default 0)',
      },
    ],
    effect: 'write',
  },
  {
    id: 'provider.list',
    label: 'List providers',
    description: 'List registered providers and whether a key is set.',
    effect: 'read',
  },
  {
    id: 'provider.add',
    label: 'Add provider',
    description: 'Register a provider.',
    args: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'provider name (e.g. anthropic)',
      },
      { name: 'baseUrl', type: 'string', description: 'override the provider base URL' },
      {
        name: 'pricingUrl',
        type: 'string',
        description: 'override the pricing reference page (where you find model prices)',
      },
    ],
    effect: 'write',
  },
  {
    id: 'provider.set-key',
    label: 'Set provider key',
    description: 'Store a provider API key in the OS keychain (the key is read from stdin).',
    args: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'provider name (e.g. anthropic)',
      },
    ],
    effect: 'write',
  },
  {
    id: 'provider.remove-key',
    label: 'Remove provider key',
    description: 'Remove a provider API key from the OS keychain.',
    args: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'provider name (e.g. anthropic)',
      },
    ],
    // destructive: irreversibly removes a stored credential (approval enforcement is 2.5.E/ADR-0057).
    effect: 'destructive',
  },
  {
    id: 'provider.test',
    label: 'Test provider key',
    description: 'Verify a provider key with a minimal live request.',
    args: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'provider name (e.g. anthropic)',
      },
      {
        name: 'model',
        type: 'string',
        description: 'model to test with (defaults to a cheap known model)',
      },
    ],
    effect: 'read',
  },
];

/** Freeze an entry and its nested `args` (items + array) so the manifest is immutable at runtime, not just in the type system. */
function freezeEntry(entry: CommandManifestEntry): CommandManifestEntry {
  if (entry.args !== undefined) {
    for (const arg of entry.args) Object.freeze(arg);
    Object.freeze(entry.args);
  }
  return Object.freeze(entry);
}

/** The validated, deep-frozen command manifest — the single source for `commander` + the `executeCommand` table + `--help --json`. */
export const COMMAND_MANIFEST: readonly CommandManifestEntry[] = Object.freeze(
  CommandManifestSchema.parse(ENTRIES).map(freezeEntry),
);

/** O(1) lookup of a manifest entry by id. */
export const MANIFEST_BY_ID: ReadonlyMap<string, CommandManifestEntry> = new Map(
  COMMAND_MANIFEST.map((entry) => [entry.id, entry]),
);
