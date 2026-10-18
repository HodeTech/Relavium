import { z } from 'zod';

import { legacyManifestEntries } from './descriptors.js';

/**
 * The **command manifest** ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C) — the compatible, strict, **alias-free** model projection of the enriched descriptor authority
 * ([descriptors.ts](descriptors.ts)). That authority also derives the current Commander grammar; the separate
 * implementation bindings in [dispatch.ts](dispatch.ts) are checked in both directions. The new CLI discovery
 * DTO lives in [discovery.ts](discovery.ts); production JSON-help integration remains Wave 3 Step 10.
 * Canonically homed in [commands.md](../../../../docs/reference/cli/commands.md), this contract belongs to
 * apps/cli, not `@relavium/shared`.
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
     * (`--base-url`) and never with leading dashes. Model command calls use these stable binding keys.
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
    /** The one-line help text shared with the descriptor-derived Commander description. */
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

/** The strict model projection derives from the single descriptor authority; CLI-only metadata stays out. */
const ENTRIES: readonly CommandManifestEntry[] = legacyManifestEntries();

/** Freeze an entry and its nested `args` (items + array) so the manifest is immutable at runtime, not just in the type system. */
function freezeEntry(entry: CommandManifestEntry): CommandManifestEntry {
  if (entry.args !== undefined) {
    for (const arg of entry.args) Object.freeze(arg);
    Object.freeze(entry.args);
  }
  return Object.freeze(entry);
}

/** The validated, deep-frozen command manifest — the compatible alias-free model projection. Enriched CLI discovery has its own DTO. */
export const COMMAND_MANIFEST: readonly CommandManifestEntry[] = Object.freeze(
  CommandManifestSchema.parse(ENTRIES).map(freezeEntry),
);

/** O(1) lookup of a manifest entry by id. */
export const MANIFEST_BY_ID: ReadonlyMap<string, CommandManifestEntry> = new Map(
  COMMAND_MANIFEST.map((entry) => [entry.id, entry]),
);
