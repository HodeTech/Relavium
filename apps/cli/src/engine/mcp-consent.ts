import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { canonicalJson } from '@relavium/shared';
import { z } from 'zod';

import { stringifyJsonLine } from '../render/sanitize.js';
import { findOnPath } from './find-on-path.js';

/**
 * The consent fingerprint and its grant log
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §3, §5).
 *
 * A `transport: stdio` declaration runs its command while the session is being constructed — before the
 * first turn, and strictly before the dispatch-time approval gate, so `ask` mode does not cover it. This
 * module answers the two questions that gate needs: *which program is this, exactly*, and *have I agreed to
 * it before*. It decides nothing about prompting; that is the caller's, and the split is what keeps this
 * file pure enough to test without a terminal.
 */

/** Mode for the grant log — owner-only, matching every other machine-local file under `~/.relavium`. */
const FILE_MODE = 0o600;

/** The digest algorithm's version. A `v2:` reader must not recognise a `v1:` grant — see {@link fingerprint}. */
const DIGEST_VERSION = 'v1';

/**
 * An authored env value that is EXACTLY one secret reference — nothing before it, nothing after.
 *
 * Anchored on purpose: `prefix-{{secrets.a}}` is a template, not a reference, and treating it as one would
 * digest two different authored strings identically. It contributes a literal instead, which is correct and
 * also the conservative direction (a change to the prefix re-prompts).
 */
const SOLE_SECRET_REFERENCE = /^\{\{\s*secrets\.([A-Za-z0-9._-]+)\s*\}\}$/;

/** What a declaration contributes to the digest for one environment variable (ADR-0084 §3). */
type EnvDigestEntry =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'secret-ref'; readonly name: string };

/** Where a declared server came from — shown at the prompt so a user knows what asked. */
export type ServerProvenance =
  | { readonly kind: 'inline' }
  | { readonly kind: 'registration'; readonly name: string };

/**
 * One stdio server, resolved far enough to be identified: the executable found, the directory canonical.
 *
 * `env` carries the **authored** values — pre-resolution, so no credential is in scope here at all. That is
 * §3's rule and it is why {@link fingerprint} can hash values without hashing secrets.
 */
export interface ResolvedStdioSpawn {
  readonly serverId: string;
  readonly provenance: ServerProvenance;
  /** The artifact that declared it (a workflow / agent path), for the prompt. Not part of identity. */
  readonly artifact?: string | undefined;
  /** As authored — shown beside the resolved path when the two differ. Not part of identity. */
  readonly command: string;
  /** The absolute, canonical executable. THIS is what is digested and what is spawned. */
  readonly resolvedCommand: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The canonical realpath of the spawn directory. */
  readonly cwd: string;
}

/** Why a declaration could not be resolved to a program — a refusal before any prompt. */
export class StdioResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StdioResolutionError';
  }
}

/**
 * Resolve a declaration to the exact program it names (ADR-0084 §3).
 *
 * A digest over the word `npx` names a word: the ambient `PATH` decides which file runs, and a directory
 * prepended to it substitutes another binary under an unchanged declaration — measured, the SDK's own
 * `cross-spawn` ran a planted one. So the executable is found FIRST, the digest carries the absolute path,
 * and the caller spawns that same path.
 *
 * Three forms, and the difference matters: an absolute `command` is canonicalized; one carrying a separator
 * resolves against `cwd` (`./bin/x` is two different files in two directories); a bare name goes to the
 * ambient `PATH`. A command that resolves nowhere is refused before the user is asked anything — an
 * unresolvable executable is not a decision anyone can meaningfully make.
 *
 * `cwd` is realpath'd so two symlinked routes to one directory are one grant rather than two.
 */
export async function resolveStdioSpawn(
  declaration: {
    readonly serverId: string;
    readonly provenance: ServerProvenance;
    readonly artifact?: string | undefined;
    readonly command: string;
    readonly args?: readonly string[] | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
  },
  cwd: string,
): Promise<ResolvedStdioSpawn> {
  const { command } = declaration;
  if (command.trim() === '') {
    throw new StdioResolutionError(
      `MCP server '${declaration.serverId}' declares an empty command`,
    );
  }
  const canonicalCwd = await canonicalize(cwd);
  const explicit = isAbsolute(command) || command.includes('/') || command.includes('\\');
  const located = explicit ? resolve(canonicalCwd, command) : await findOnPath(command);
  if (located === undefined) {
    throw new StdioResolutionError(
      `MCP server '${declaration.serverId}' names a command that is not on PATH`,
    );
  }
  return {
    serverId: declaration.serverId,
    provenance: declaration.provenance,
    ...(declaration.artifact === undefined ? {} : { artifact: declaration.artifact }),
    command,
    resolvedCommand: await canonicalize(located),
    args: declaration.args ?? [],
    env: declaration.env ?? {},
    cwd: canonicalCwd,
  };
}

/** `realpath`, falling back to the lexical form when the path does not exist yet — never throwing here. */
async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  return realpath(absolute).catch(() => absolute);
}

/**
 * The consent fingerprint: `v1:<64 lowercase hex>` (ADR-0084 §3).
 *
 * **Env values are IN, type-tagged.** An earlier draft excluded them, reasoning that hashing a placeholder
 * would churn on secret rotation. It would not — `{{secrets.foo}}` is authored text, and rotating the
 * keychain entry changes what the resolver returns at spawn time, never the text. Excluding them cost the
 * whole guarantee: `NODE_OPTIONS` is a NAME, so one grant matched every value of it.
 *
 * The tag is load-bearing rather than decorative. A flat `secret:<name>` marker collided with the literal
 * string of the same text, so an approved literal could later become a real credential reference with no
 * re-prompt. A sole reference contributes only the referenced NAME — the credential never enters the digest,
 * and swapping `{{secrets.a}}` for `{{secrets.b}}` still re-prompts.
 *
 * The `v1:` prefix is what makes a future change to any of this fail CLOSED: a `v2:` reader recognises no
 * `v1:` grant, so the machine re-prompts rather than matching under rules it no longer follows.
 */
export function fingerprint(spawn: ResolvedStdioSpawn): string {
  const env: Record<string, EnvDigestEntry> = {};
  for (const [name, value] of Object.entries(spawn.env)) {
    const reference = SOLE_SECRET_REFERENCE.exec(value);
    env[name] =
      reference?.[1] === undefined
        ? { kind: 'literal', value }
        : { kind: 'secret-ref', name: reference[1] };
  }
  const payload = canonicalJson({
    transport: 'stdio',
    command: spawn.resolvedCommand,
    args: [...spawn.args],
    env,
    cwd: spawn.cwd,
  });
  return `${DIGEST_VERSION}:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

// --- the grant log ------------------------------------------------------------------------------

/** One recorded consent. The comparison metadata exists for the prompt, never for the digest. */
const ConsentGrantSchema = z
  .object({
    v: z.literal(1),
    digest: z.string().min(1),
    command: z.string(),
    args: z.array(z.string()),
    envNames: z.array(z.string()),
    cwd: z.string(),
    grantedAt: z.string().min(1),
  })
  .strict();
export type ConsentGrant = z.infer<typeof ConsentGrantSchema>;

/** A revocation. Append-only means a grant is withdrawn by a later line, never by rewriting an earlier one. */
const ConsentTombstoneSchema = z
  .object({ v: z.literal(1), revoked: z.string().min(1), revokedAt: z.string().min(1) })
  .strict();

/**
 * The effective grants, or `undefined` when the log could not be folded (ADR-0084 §5).
 *
 * **`undefined` means NO GRANTS, and that is the whole point of returning it.** Skipping an unparseable line
 * and keeping the rest is the tempting answer and the wrong one: a truncated line may be a TOMBSTONE, and
 * dropping it silently resurrects a grant the user revoked. Folding the whole file closed costs one prompt
 * and cannot re-authorize anything. It is a deliberate divergence from the terminal outbox, which skips a
 * partial line — there, one lost entry is one un-retried terminal; here, one lost line is a trust decision
 * reversed without anyone saying so.
 */
export function readGrants(path: string): ReadonlyMap<string, ConsentGrant> | undefined {
  if (!existsSync(path)) return new Map();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const grants = new Map<string, ConsentGrant>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue; // the leading-newline framing, and a trailing terminator
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return undefined;
    }
    const tombstone = ConsentTombstoneSchema.safeParse(raw);
    if (tombstone.success) {
      grants.delete(tombstone.data.revoked);
      continue;
    }
    const grant = ConsentGrantSchema.safeParse(raw);
    if (!grant.success) return undefined;
    grants.set(grant.data.digest, grant.data);
  }
  return grants;
}

/**
 * Record one consent (ADR-0084 §5).
 *
 * **Append, never replace.** The terminal outbox began as a rewrite-in-place file and became append-only
 * because a concurrent process's write was silently destroyed inside another's truncate window; concurrent
 * `relavium` processes over one `~/.relavium` are designed for, not hypothetical. A temp-file + `rename`
 * here would reintroduce exactly that: the rename discards whatever another process appended in between.
 *
 * The file is created with `openSync(path, 'wx', 0o600)` — owner-only from the FIRST byte, not a `chmod`
 * afterwards, which this project has already been bitten by. Losing that race is fine: the winner's empty
 * file is the file, and the loser proceeds to append into it. The mode is self-healed on every write, so a
 * file restored from a backup with a wider mode is repaired rather than trusted.
 */
export function appendGrant(path: string, grant: ConsentGrant): void {
  ensureFile(path);
  // A LEADING newline as well as a trailing one: a process killed mid-append leaves a partial last line with
  // no terminator, and appending straight onto it would concatenate into one corrupt line — which, under
  // this file's fail-closed fold, would cost every grant on the machine rather than one entry.
  appendFileSync(path, `\n${stringifyJsonLine(grant)}\n`, { mode: FILE_MODE });
  healMode(path);
}

/** Withdraw a grant by appending a tombstone — the fold drops the digest when it sees one. */
export function appendRevocation(path: string, digest: string, revokedAt: string): void {
  ensureFile(path);
  appendFileSync(path, `\n${stringifyJsonLine({ v: 1, revoked: digest, revokedAt })}\n`, {
    mode: FILE_MODE,
  });
  healMode(path);
}

function ensureFile(path: string): void {
  if (existsSync(path)) return;
  try {
    closeSync(openSync(path, 'wx', FILE_MODE));
  } catch {
    // Another process created it between the check and the open — its empty file is the file, and the
    // append below lands in it. `wx` is what makes that race harmless rather than a truncation.
  }
}

function healMode(path: string): void {
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // Windows, or a file we do not own. The at-rest guard there is the per-user profile ACL (ADR-0050).
  }
}
