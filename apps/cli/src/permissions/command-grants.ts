import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { findOnPath } from '../engine/find-on-path.js';
import { stringifyJsonLine } from '../render/sanitize.js';
import type { KeychainStore } from '../secrets/keychain.js';

/**
 * Remembered command grants ([ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2).
 *
 * "Remember this command" is the person's consent for ONE exact argv under ONE project root on ONE machine. It is stored in an
 * operator-owned append-only file and never in a repository file, because anything in a repository arrives with every clone. A
 * record holds a KEYED DIGEST of the argv and never the command: an argument can carry a password, the credential masking
 * recognizes only a finite set of shapes, and an unkeyed hash of a short secret is recoverable by trying candidates. The digest key
 * lives in the OS keychain beside the provider keys and never enters a file, a log or an event.
 *
 * The file protocol is [ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §5's, for the same reasons:
 * created `wx` with mode `0600` (owner-only from the first byte), one bounded record per `appendFileSync` with a LEADING newline
 * (so a process killed mid-append cannot weld its partial line onto the next record), the mode self-healed on every touch, a
 * symlink or a non-regular file refused (for reads as well as writes), NO lock, and append-only with tombstones. A `revoked` line
 * cancels the grant with that id wherever it appears in the file, so replaying an old grant line cannot bring it back; two records
 * for one argv (two processes that remembered it at the same moment) are ONE grant, and revoking it tombstones both.
 *
 * **Fail closed, never skip.** Any unparseable line makes the WHOLE store "no grants" for the invocation, reported once. Skipping
 * a bad line is the tempting answer and the wrong one: a truncated line may be a tombstone, and dropping it would resurrect a grant
 * the person revoked.
 */

/** The file's name under `~/.relavium`. */
export const COMMAND_GRANTS_FILE = 'command-grants.ndjson';

/** Where the grants live: beside `history.db`, the terminal outbox and the MCP consent log. */
export function commandGrantsPath(homeDir: string): string {
  return join(homeDir, '.relavium', COMMAND_GRANTS_FILE);
}

/** The keychain account of the per-installation digest key. Not a provider account, so it can never collide with one. */
export const COMMAND_GRANTS_KEY_ACCOUNT = 'relavium-internal:command-grants-digest-key';

/** The bounds of ADR-0118 §2. A write that would pass one is refused; a file that already passes one reads as "no grants". */
export const COMMAND_GRANT_LIMITS = Object.freeze({
  perRoot: 64,
  total: 1024,
  lines: 8192,
  bytes: 2 * 1024 * 1024,
});

/** A grant record is well under this: the schema bounds every field. Used to refuse a write that could pass the size bound. */
const RECORD_BYTES_BOUND = 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const ROOT_TAG = 'relavium/command-grants/root/v1';
const GRANT_TAG = 'relavium/command-grants/grant/v1';
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
/** `argv[0]` may be named in a label only when it is this shape AND resolves on the PATH (ADR-0118 §2): it is free text otherwise. */
const BARE_PROGRAM = /^[A-Za-z0-9._+-]{1,64}$/u;
/** What a label says when the program cannot be named without risking a credential. */
export const UNNAMED_PROGRAM = '(unnamed program)';

/** What `toISOString()` writes. A free-text time would let a hand-edited line put a newline or an escape into a listing. */
const ISO_TIME = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/u);

const GrantRecordSchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(/^[0-9a-zA-Z-]{1,64}$/u),
    root: z.string().regex(HEX_DIGEST),
    grant: z.string().regex(HEX_DIGEST),
    program: z.string().regex(BARE_PROGRAM).optional(),
    args: z.number().int().min(0).max(100_000),
    at: ISO_TIME,
  })
  .strict();
type GrantRecord = z.infer<typeof GrantRecordSchema>;

const TombstoneSchema = z
  .object({
    v: z.literal(1),
    revoked: z.string().regex(/^[0-9a-zA-Z-]{1,64}$/u),
    at: ISO_TIME,
  })
  .strict();

/** What `relavium permissions list` and the chat's `/permissions` show: never the command, only a label. */
export interface GrantSummary {
  /** 1-based, in file order, among THIS root's live grants. `revoke` takes it. */
  readonly index: number;
  readonly id: string;
  /** The program's bare name when it could be named safely, else {@link UNNAMED_PROGRAM}. */
  readonly program: string;
  /** How many arguments follow the program. */
  readonly args: number;
  readonly grantedAt: string;
}

/** Why the store cannot answer or accept a grant right now. */
export type CommandGrantUnavailable =
  /** The OS keychain is absent, locked or denied, or holds no digest key yet: no grant can be verified or written. */
  | 'no-key'
  /** A line did not parse, or the file passes a bound: the whole store reads as "no grants". */
  | 'unreadable'
  /** The directory or file cannot be written safely (a symlink, a permission). */
  | 'unwritable';

export type RememberResult =
  | { readonly ok: true; readonly id: string; readonly alreadyRemembered: boolean }
  | { readonly ok: false; readonly reason: CommandGrantUnavailable | 'full' };

export type ListResult =
  | { readonly ok: true; readonly grants: readonly GrantSummary[] }
  | { readonly ok: false; readonly reason: CommandGrantUnavailable };

export type RevokeResult =
  | {
      readonly ok: true;
      readonly id: string;
      /** What was withdrawn, so the confirmation names it: a number taken from an older list can name a different grant. */
      readonly program: string;
      readonly args: number;
    }
  | {
      readonly ok: false;
      /** `full`: the tombstone would pass the line or size bound; only `revoke --all` recovers. */
      readonly reason: CommandGrantUnavailable | 'no-such-grant' | 'full';
    };

/** `removed: false` means there was no file to remove; a file that could not be removed is a failure, never "nothing to remove". */
export type RevokeAllResult =
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly reason: 'unwritable' };

/** The grant store for ONE project root. */
export interface CommandGrantStore {
  /** Whether a remembered grant covers exactly this argv under this root. A store that cannot answer says `false`. */
  matches: (argv: readonly string[]) => boolean;
  /** Whether Remember can be offered right now: the key is usable, the file is readable and writable, and a bound has room. */
  canRemember: () =>
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: CommandGrantUnavailable | 'full' };
  /** Persist a grant for this exact argv. Idempotent: an existing live grant is reported, not duplicated. */
  remember: (argv: readonly string[]) => Promise<RememberResult>;
  /** This root's live grants, in file order. */
  list: () => ListResult;
  /** Withdraw the grant at the 1-based index of {@link list} by appending a tombstone. */
  revoke: (index: number) => RevokeResult;
  /** Remove the whole file: the recovery that needs no text editor. Every root's grants go. */
  revokeAll: () => RevokeAllResult;
}

export interface CommandGrantStoreDeps {
  /** The operator's home (the directory that holds `.relavium`). */
  readonly homeDir: string;
  /** The project root the grants are keyed by: its resolved real path is what is digested. */
  readonly projectRoot: string;
  readonly keychain: KeychainStore;
  /** Told once per store when the file cannot be read: a bad line or a bound. Never given a command. */
  readonly notify?: (message: string) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Resolve a bare program name on the PATH, as the spawn would. Injected so a test needs no real PATH. */
  readonly findProgram?: (name: string) => Promise<string | undefined>;
}

/**
 * The project root remembered grants are keyed by: the directory that holds the nearest `.relavium/` (else the working
 * directory). One function for the chat session and `relavium permissions`, so a grant made in one is the grant the other lists.
 */
export function commandGrantRoot(cwd: string, projectConfigDir: string | undefined): string {
  return projectConfigDir === undefined ? cwd : dirname(projectConfigDir);
}

/** The canonical root: the resolved real path, so two paths to one tree share grants. Falls back to the resolved path. */
export function canonicalRoot(projectRoot: string): string {
  try {
    // `.native` canonicalizes case and 8.3 names on case-insensitive file systems; the JS version keeps the spelling it was given.
    return realpathSync.native(projectRoot);
  } catch {
    return resolve(projectRoot);
  }
}

/** HMAC-SHA256 over a version tag and the canonical root, under the digest key. */
export function rootDigest(key: Buffer, canonical: string): string {
  return createHmac('sha256', key).update(`${ROOT_TAG}\0`).update(canonical, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256 over a version tag, the ROOT digest and the argv, each element length-prefixed (four bytes, big-endian) so
 * `["cat a b"]`, `["cat","a b"]` and `["cat","a","b"]` are three different inputs. Binding the root digest means a record copied
 * to another root's lines never validates.
 */
export function grantDigest(key: Buffer, root: string, argv: readonly string[]): string {
  const hmac = createHmac('sha256', key).update(`${GRANT_TAG}\0`).update(root, 'utf8').update('\0');
  const count = Buffer.alloc(4);
  count.writeUInt32BE(argv.length);
  hmac.update(count);
  for (const element of argv) {
    const bytes = Buffer.from(element, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length).update(bytes);
  }
  return hmac.digest('hex');
}

/** Constant-time comparison of two hex digests. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A live grant, with the ids of any OTHER records for the same argv (two processes that remembered it at the same moment). */
interface LiveGrant extends GrantRecord {
  readonly twins: readonly string[];
}

interface Fold {
  /** Live grants in file order, one per argv. */
  readonly grants: readonly LiveGrant[];
  readonly lines: number;
  readonly bytes: number;
}

type ReadFold = { readonly ok: true; readonly fold: Fold } | { readonly ok: false };

/** The key, or `undefined` when the keychain is unusable. Read once per store; never generated on a read. */
type KeyState =
  | { readonly kind: 'ready'; readonly key: Buffer }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' };

export function createCommandGrantStore(deps: CommandGrantStoreDeps): CommandGrantStore {
  const path = commandGrantsPath(deps.homeDir);
  const canonical = canonicalRoot(deps.projectRoot);
  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? ((): string => randomUUID());
  const findProgram = deps.findProgram ?? findOnPath;
  let keyState: KeyState | undefined;
  let reported = false;

  const report = (message: string): void => {
    if (reported) return;
    reported = true;
    deps.notify?.(message);
  };

  const readKey = (): KeyState => {
    if (keyState?.kind === 'ready') return keyState;
    try {
      const stored = deps.keychain.get(COMMAND_GRANTS_KEY_ACCOUNT);
      if (stored === null) return { kind: 'absent' };
      const key = Buffer.from(stored, 'base64');
      // A short or empty entry is not a key; treating it as one would make the digests guessable.
      if (key.length < 32) return { kind: 'unavailable' };
      keyState = { kind: 'ready', key };
      return keyState;
    } catch {
      // Absent, locked or denied: the store is present but unusable. Nothing about the failure is kept (it may carry secrets).
      return { kind: 'unavailable' };
    }
  };

  /** Generate the key on first WRITE: store it and read it back, so a keychain that drops writes is caught before a grant is made. */
  const ensureKey = (): Buffer | undefined => {
    const existing = readKey();
    if (existing.kind === 'ready') return existing.key;
    if (existing.kind === 'unavailable') return undefined;
    try {
      const fresh = randomBytes(32);
      deps.keychain.set(COMMAND_GRANTS_KEY_ACCOUNT, fresh.toString('base64'));
      const back = deps.keychain.get(COMMAND_GRANTS_KEY_ACCOUNT);
      if (back === null) return undefined;
      const stored = Buffer.from(back, 'base64');
      // Two processes that race here can each store a key and the later store wins: a grant written under the overwritten key
      // never matches again (the card asks again), which is the fail-closed outcome. Use what the keychain now holds.
      if (stored.length < 32) return undefined;
      keyState = { kind: 'ready', key: stored };
      return stored;
    } catch {
      return undefined;
    }
  };

  /**
   * Read the file as a regular file only: opened without following a symlink and without blocking, then checked on the descriptor, so a
   * symlink, a FIFO or a device at the path reads as "unreadable" instead of being followed or hanging the approval hook.
   */
  const readText = ():
    | { readonly text: string; readonly bytes: number }
    | 'absent'
    | 'unreadable' => {
    if (lstatOrUndefined(path) === undefined) return 'absent';
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const info = fstatSync(fd);
      if (!info.isFile()) {
        report(unreadableMessage(path, 'it is not a regular file'));
        return 'unreadable';
      }
      if (info.size > COMMAND_GRANT_LIMITS.bytes) {
        report(unreadableMessage(path, 'it is larger than the size bound'));
        return 'unreadable';
      }
      return { text: readFileSync(fd, 'utf8'), bytes: info.size };
    } catch {
      report(unreadableMessage(path, 'it cannot be read, or it is a symbolic link'));
      return 'unreadable';
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const readFold = (): ReadFold => {
    const read = readText();
    if (read === 'absent') return { ok: true, fold: { grants: [], lines: 0, bytes: 0 } };
    if (read === 'unreadable') return { ok: false };
    const records = new Map<string, GrantRecord>();
    const revoked = new Set<string>();
    let lines = 0;
    for (const line of read.text.split('\n')) {
      if (line.trim() === '') continue; // the leading-newline framing and a trailing terminator
      lines += 1;
      if (lines > COMMAND_GRANT_LIMITS.lines) {
        report(unreadableMessage(path, 'it has more lines than the bound'));
        return { ok: false };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        report(unreadableMessage(path, 'a line does not parse'));
        return { ok: false };
      }
      const tombstone = TombstoneSchema.safeParse(raw);
      if (tombstone.success) {
        revoked.add(tombstone.data.revoked);
        continue;
      }
      const grant = GrantRecordSchema.safeParse(raw);
      if (!grant.success) {
        report(unreadableMessage(path, 'a line is not a grant or a revocation'));
        return { ok: false };
      }
      if (!records.has(grant.data.id)) records.set(grant.data.id, grant.data);
    }
    // Revocation does not depend on file order: a replayed or reordered grant line stays revoked. Two live records for one argv are
    // one grant (the first is kept, the other ids are its twins, so revoking it withdraws both).
    const byDigest = new Map<string, { record: GrantRecord; twins: string[] }>();
    for (const record of records.values()) {
      if (revoked.has(record.id)) continue;
      const seen = byDigest.get(record.grant);
      if (seen === undefined) byDigest.set(record.grant, { record, twins: [] });
      else seen.twins.push(record.id);
    }
    const grants = [...byDigest.values()].map(
      ({ record, twins }): LiveGrant => ({ ...record, twins }),
    );
    const perRoot = new Map<string, number>();
    for (const grant of grants) perRoot.set(grant.root, (perRoot.get(grant.root) ?? 0) + 1);
    if (
      grants.length > COMMAND_GRANT_LIMITS.total ||
      [...perRoot.values()].some((count) => count > COMMAND_GRANT_LIMITS.perRoot)
    ) {
      report(unreadableMessage(path, 'it has more grants than the bound'));
      return { ok: false };
    }
    return { ok: true, fold: { grants, lines, bytes: read.bytes } };
  };

  const rootGrants = (fold: Fold, root: string): readonly LiveGrant[] =>
    fold.grants.filter((grant) => sameDigest(grant.root, root));

  const matches = (argv: readonly string[]): boolean => {
    if (argv.length === 0) return false; // a call always names a program
    const state = readKey();
    if (state.kind !== 'ready') return false;
    const folded = readFold();
    if (!folded.ok) return false;
    const root = rootDigest(state.key, canonical);
    const candidate = grantDigest(state.key, root, argv);
    return rootGrants(folded.fold, root).some((grant) => sameDigest(grant.grant, candidate));
  };

  const room = (
    fold: Fold,
    root: string,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: 'full' } => {
    if (
      fold.lines + 2 > COMMAND_GRANT_LIMITS.lines ||
      fold.bytes + RECORD_BYTES_BOUND > COMMAND_GRANT_LIMITS.bytes ||
      fold.grants.length >= COMMAND_GRANT_LIMITS.total ||
      rootGrants(fold, root).length >= COMMAND_GRANT_LIMITS.perRoot
    )
      return { ok: false, reason: 'full' };
    return { ok: true };
  };

  /**
   * Best effort, so the card does not offer Remember into a write that cannot succeed: an existing file must be a regular file the
   * process can write, a missing one needs a directory (or the home, where it is created) the process can write. The write path
   * re-checks everything, so a wrong answer here costs a notice, never a grant.
   */
  const writable = (): boolean => {
    const info = lstatOrUndefined(path);
    try {
      if (info !== undefined) {
        if (info.isSymbolicLink() || !info.isFile()) return false;
        accessSync(path, constants.W_OK);
        return true;
      }
      accessSync(
        lstatOrUndefined(dirname(path)) === undefined ? deps.homeDir : dirname(path),
        constants.W_OK,
      );
      return true;
    } catch {
      return false;
    }
  };

  const canRemember = (): ReturnType<CommandGrantStore['canRemember']> => {
    const state = readKey();
    // An absent key can be generated at the first write; an unusable keychain cannot. The write path re-checks.
    if (state.kind === 'unavailable') return { ok: false, reason: 'no-key' };
    const folded = readFold();
    if (!folded.ok) return { ok: false, reason: 'unreadable' };
    if (!writable()) return { ok: false, reason: 'unwritable' };
    const root = state.kind === 'ready' ? rootDigest(state.key, canonical) : '0'.repeat(64); // no grants can exist without a key
    return room(folded.fold, root);
  };

  const remember = async (argv: readonly string[]): Promise<RememberResult> => {
    if (argv.length === 0) throw new RangeError('a command grant needs a program');
    // The only await comes first: from the read of the file to the append nothing yields, so two calls in one process cannot both
    // pass the "already remembered" check. Two PROCESSES still can; the fold treats the two records as one grant.
    const program = await namedProgram(argv[0], findProgram);
    const key = ensureKey();
    if (key === undefined) return { ok: false, reason: 'no-key' };
    const folded = readFold();
    if (!folded.ok) return { ok: false, reason: 'unreadable' };
    const root = rootDigest(key, canonical);
    const grant = grantDigest(key, root, argv);
    const existing = rootGrants(folded.fold, root).find((record) =>
      sameDigest(record.grant, grant),
    );
    if (existing !== undefined) return { ok: true, id: existing.id, alreadyRemembered: true };
    const space = room(folded.fold, root);
    if (!space.ok) return space;
    const record: GrantRecord = {
      v: 1,
      id: newId(),
      root,
      grant,
      ...(program === undefined ? {} : { program }),
      args: Math.max(0, argv.length - 1),
      at: now().toISOString(),
    };
    try {
      appendLine(path, record);
    } catch {
      return { ok: false, reason: 'unwritable' };
    }
    return { ok: true, id: record.id, alreadyRemembered: false };
  };

  const list = (): ListResult => {
    const state = readKey();
    if (state.kind === 'unavailable') return { ok: false, reason: 'no-key' };
    const folded = readFold();
    if (!folded.ok) return { ok: false, reason: 'unreadable' };
    // No key yet means no grant was ever written under this machine's key: the honest answer is an empty list, not a fault.
    if (state.kind === 'absent') return { ok: true, grants: [] };
    const root = rootDigest(state.key, canonical);
    return {
      ok: true,
      grants: rootGrants(folded.fold, root).map((grant, offset) => ({
        index: offset + 1,
        id: grant.id,
        program: grant.program ?? UNNAMED_PROGRAM,
        args: grant.args,
        grantedAt: grant.at,
      })),
    };
  };

  const revoke = (index: number): RevokeResult => {
    const state = readKey();
    if (state.kind === 'unavailable') return { ok: false, reason: 'no-key' };
    const folded = readFold();
    if (!folded.ok) return { ok: false, reason: 'unreadable' };
    if (state.kind === 'absent') return { ok: false, reason: 'no-such-grant' };
    const target = rootGrants(folded.fold, rootDigest(state.key, canonical))[index - 1];
    if (target === undefined) return { ok: false, reason: 'no-such-grant' };
    const ids = [target.id, ...target.twins];
    // A tombstone is a line too. Remember leaves room for one (see `room`), but a store at its bound cannot take another line:
    // better to say so than to push the file past the bound, where every grant in it would read as "no grants".
    if (
      folded.fold.lines + ids.length > COMMAND_GRANT_LIMITS.lines ||
      folded.fold.bytes + ids.length * RECORD_BYTES_BOUND > COMMAND_GRANT_LIMITS.bytes
    )
      return { ok: false, reason: 'full' };
    try {
      for (const id of ids) appendLine(path, { v: 1, revoked: id, at: now().toISOString() });
    } catch {
      return { ok: false, reason: 'unwritable' };
    }
    return {
      ok: true,
      id: target.id,
      program: target.program ?? UNNAMED_PROGRAM,
      args: target.args,
    };
  };

  const revokeAll = (): RevokeAllResult => removeCommandGrantsFile(deps.homeDir);

  return { matches, canRemember, remember, list, revoke, revokeAll };
}

/**
 * Remove the whole file, for every project: the recovery that needs no key, no project root and no readable file. A file that
 * cannot be removed is a failure, never "nothing to remove". An unlink removes a symlink itself, not what it points at.
 */
export function removeCommandGrantsFile(homeDir: string): RevokeAllResult {
  const path = commandGrantsPath(homeDir);
  if (lstatOrUndefined(path) === undefined) return { ok: true, removed: false };
  try {
    unlinkSync(path);
    return { ok: true, removed: true };
  } catch {
    // Lost a race with another remover, or a permission refusal: only the file's absence now tells them apart.
    return lstatOrUndefined(path) === undefined
      ? { ok: true, removed: false }
      : { ok: false, reason: 'unwritable' };
  }
}

function unreadableMessage(path: string, why: string): string {
  return `The remembered-command file ${path} was ignored (${why}); remembered commands will ask again. \`relavium permissions revoke --all\` removes it.`;
}

/** The program's bare name, only when it is a bare name that resolves on the PATH; else `undefined` (ADR-0118 §2). */
async function namedProgram(
  first: string | undefined,
  findProgram: (name: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (first === undefined || !BARE_PROGRAM.test(first)) return undefined;
  try {
    return (await findProgram(first)) === undefined ? undefined : first;
  } catch {
    return undefined;
  }
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * One record, one `appendFileSync`, with a LEADING newline (a process killed mid-append leaves a partial last line with no
 * terminator, and appending straight onto it would weld two records into one corrupt line, which the fail-closed fold would turn
 * into "no grants" for the whole machine). The file is created `wx` with the owner-only mode from its FIRST byte; losing that
 * race is fine, the winner's file is the file.
 */
function appendLine(path: string, record: object): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    closeSync(openSync(path, 'wx', FILE_MODE));
  } catch {
    // EEXIST: another process created it first; its empty file is the file and the append below lands in it.
  }
  const info = lstatOrUndefined(path);
  if (info?.isSymbolicLink() === true) {
    throw new Error('the remembered-command file is a symbolic link; refusing to write through it');
  }
  appendFileSync(path, `\n${stringifyJsonLine(record)}\n`, { mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // Windows, or a file we do not own: the guard there is the per-user profile ACL (ADR-0050).
  }
}
