import { createHash } from 'node:crypto';
import { constants, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { RelaviumError, canonicalJson } from '@relavium/shared';
import { z } from 'zod';

import { readRegularFile } from '../permissions/file-state.js';
import { stringifyJsonLine } from '../render/sanitize.js';
import { findOnPath } from './find-on-path.js';
import { AppendTargetRefusedError, appendToOwnerOnlyFile } from './owner-only-append.js';

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
export class StdioResolutionError extends RelaviumError {
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
  // **An explicit path is VERIFIED, not merely resolved.** `path.resolve` is string arithmetic — it never
  // fails and never touches the filesystem — so a declared `/opt/acme/server` that does not exist used to
  // sail through, produce a fingerprint, and be consented to. Anything later materialising at that exact
  // path — a delayed install, a mount, a local write — would then spawn under a grant nobody had evaluated
  // against a real program. That is the TOCTOU §3's "resolve before the gate" exists to close, and the
  // bare-name branch already closes it because `findOnPath` checks access; this branch did not.
  const located = explicit
    ? await verifyExecutable(resolve(canonicalCwd, command))
    : await findOnPath(command);
  if (located === undefined) {
    throw new StdioResolutionError(
      `MCP server '${declaration.serverId}' names a command that does not resolve to an executable file`,
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

/** An existing, executable regular file at `path`, or `undefined` — the same bar `findOnPath` applies. */
async function verifyExecutable(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    await access(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
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
 * The most bytes of grant log {@link readGrants} reads, 4 MiB: 256 lines of the largest size one can be ({@link MAX_CONSENT_LINE_BYTES}), or
 * thousands of ordinary ones (a grant line is usually well under a kilobyte). A log past it is a planted or runaway file, and it reads as
 * "no grants" rather than being read whole into memory. So that an honest log never gets there unannounced, a record that would take the
 * file past this bound is REFUSED when it is written ({@link append}), with the way out named, instead of being appended and then never read.
 */
export const MAX_CONSENT_STORE_BYTES = 4 * 1024 * 1024;

/**
 * The most bytes ONE serialized line of the log (its two framing newlines included) may take, 16 KiB. The comparison metadata of a grant is
 * clipped to 512 characters a string and 64 entries a list, but that bound is on CHARACTERS and on entries, not on the line: 64 arguments and
 * 64 variable names of 512 characters are about 66 KB, and a control character, a C1 character or a bidi mark is escaped to six bytes, so a
 * hostile declaration could make a line of about 400 KB, and about ten such approvals would take the log past {@link MAX_CONSENT_STORE_BYTES}
 * for good. An ordinary line is a few hundred bytes, so 16 KiB leaves it a wide margin and a single `write` stays one small record.
 */
export const MAX_CONSENT_LINE_BYTES = 16 * 1024;

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
  // The same read the operator's two permission files get: a link, a FIFO, a device or a directory at the path, or a file over the size
  // bound, is "could not be read" (no grants) instead of being followed, waited on or slurped whole. An absent file is simply empty.
  const read = readRegularFile(path, MAX_CONSENT_STORE_BYTES);
  if (read.kind === 'absent') return new Map();
  if (read.kind === 'refused') return undefined;
  const { text } = read;
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
  append(path, boundedLine(grant));
}

/** Withdraw a grant by appending a tombstone — the fold drops the digest when it sees one. */
export function appendRevocation(path: string, digest: string, revokedAt: string): void {
  ensureFile(path);
  append(path, `\n${stringifyJsonLine({ v: 1, revoked: digest, revokedAt })}\n`);
}

function ensureFile(path: string): void {
  // **No `existsSync` short-circuit.** The exclusive create is ALWAYS attempted, so the `wx` flag is the
  // thing that decides — losing the race to another process is an ordinary `EEXIST` and the append below
  // lands in the winner's file. With a short-circuit, `wx` and a truncating `w` were indistinguishable in
  // every observable way, which made the flag that prevents a truncate-on-create race untestable.
  try {
    // **The DIRECTORY too.** The terminal outbox may assume `~/.relavium` exists because `history.db`'s
    // opener created it, but a consent decision happens on a machine that may never have run a workflow —
    // the very first `relavium run` of a freshly imported artifact is exactly the case this gate is for.
    // `0700`, matching the posture the history opener establishes.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'wx', FILE_MODE));
  } catch {
    // Another process created it between the check and the open — its empty file is the file, and the
    // append below lands in it. `wx` is what makes that race harmless rather than a truncation.
  }
}

/**
 * The grant's whole serialized line, bounded so one append is genuinely one bounded record (§5).
 *
 * §5 claims "a single `appendFileSync` of one bounded record", and nothing bounded it: neither `McpServerRefSchema` nor `ConsentGrant` caps
 * an `args` count, an `env` count, or a string length, so a declaration could produce a line of megabytes — well past where a single write
 * is reliably atomic, which is the property the no-lock concurrent-append design leans on. The metadata is first clipped to
 * {@link MAX_METADATA_ENTRIES} entries of {@link MAX_METADATA_CHARS} characters; the LINE is then held to {@link MAX_CONSENT_LINE_BYTES}
 * (those character bounds alone allow about 400 KB once control characters are escaped) by keeping fewer entries and shorter strings
 * until it fits, so the log's growth is bounded by a number of bytes, not of characters.
 *
 * Only the metadata is ever trimmed, so a grant is never REFUSED for being wordy (a refused record fails the run the person has just
 * approved). The `digest` is fixed-size and is the IDENTITY; `command`, `args`, `envNames` and `cwd` exist so a later prompt can say what
 * changed, and a shorter diff is a smaller loss than a torn line that folds the whole store closed. With no entries and 64 characters a string
 * the line is under a kilobyte, so the last step always fits.
 */
function boundedLine(grant: ConsentGrant): string {
  for (const [entries, chars] of CLIP_STEPS) {
    // A LEADING newline as well as a trailing one: a process killed mid-append leaves a partial last line with
    // no terminator, and appending straight onto it would concatenate into one corrupt line — which, under
    // this file's fail-closed fold, would cost every grant on the machine rather than one entry.
    const line = `\n${stringifyJsonLine(clipGrant(grant, entries, chars))}\n`;
    if (Buffer.byteLength(line, 'utf8') <= MAX_CONSENT_LINE_BYTES) return line;
  }
  throw new ConsentStoreError('the MCP consent record is too large to store');
}

/** `grant` with its comparison metadata cut to `entries` entries a list and `chars` characters a string. */
function clipGrant(grant: ConsentGrant, entries: number, chars: number): ConsentGrant {
  const clip = (text: string): string => (text.length <= chars ? text : `${text.slice(0, chars)}…`);
  return {
    ...grant,
    command: clip(grant.command),
    args: grant.args.slice(0, entries).map(clip),
    envNames: grant.envNames.slice(0, entries).map(clip),
    cwd: clip(grant.cwd),
  };
}

/** Per-string and per-list ceilings for the stored comparison metadata: the first step of {@link CLIP_STEPS}. */
const MAX_METADATA_CHARS = 512;
const MAX_METADATA_ENTRIES = 64;

/** What a record is cut to, [entries a list, characters a string], until its line fits {@link MAX_CONSENT_LINE_BYTES}; the first is the normal bound. */
const CLIP_STEPS: readonly (readonly [number, number])[] = [
  [MAX_METADATA_ENTRIES, MAX_METADATA_CHARS],
  [16, MAX_METADATA_CHARS],
  [4, 128],
  [0, 64],
];

/** The sentence this store carries for each way the shared append refuses its target. */
const APPEND_REFUSAL_SENTENCES: Readonly<Record<AppendTargetRefusedError['reason'], string>> = {
  symlink: 'the MCP consent store is a symbolic link; refusing to write through it',
  'hard-link': 'the MCP consent store has more than one hard link; refusing to write to it',
  'not-regular': 'the MCP consent store is not a regular file; refusing to write to it',
};

/**
 * One append through ONE descriptor ({@link appendToOwnerOnlyFile}): a link at the grant path is refused unfollowed, and so is a file
 * that is not a regular one, and the `0600` mode is set on the descriptor that was written.
 *
 * `ensureFile`'s exclusive create refuses to follow a link at first creation, but a later append that opened the path again would
 * follow one — so a process that replaced the file with a symlink after the first write turned this store into a write primitive
 * against any file the CLI can write. A review reproduced a grant record landing in an arbitrary target. ADR-0084 accepts that
 * anything with write access to `~/.relavium` can edit the grant FILE; using it to write somewhere else is a different thing, and
 * not accepted. An earlier version closed it with an `lstat` followed by `appendFileSync` and `chmodSync`, which left a window
 * between the check and each of the two operations; the open, the check and the write are now one file.
 */
function append(path: string, text: string): void {
  // A log that grew past the bound would be refused by EVERY later read, and each later approval would be appended and never seen: say so
  // now, at the write that would do it, with the way out (a link or a special file is the append's own refusal, below).
  if (sizeOf(path) + Buffer.byteLength(text, 'utf8') > MAX_CONSENT_STORE_BYTES) {
    throw new ConsentStoreError(
      'the MCP consent store is full; delete it or move it aside to start a new one',
    );
  }
  try {
    appendToOwnerOnlyFile(path, text, FILE_MODE);
  } catch (error) {
    if (error instanceof AppendTargetRefusedError) {
      throw new ConsentStoreError(APPEND_REFUSAL_SENTENCES[error.reason]);
    }
    throw error;
  }
}

/** The size of the file at `path` itself (a link is not followed), `0` when there is none or it cannot be inspected. */
function sizeOf(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

/** The grant store could not be written safely. A refusal, never a silent skip. */
export class ConsentStoreError extends RelaviumError {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentStoreError';
  }
}
