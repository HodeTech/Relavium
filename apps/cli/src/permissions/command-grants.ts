import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { findOnPath } from '../engine/find-on-path.js';
import { AppendTargetRefusedError, appendToOwnerOnlyFile } from '../engine/owner-only-append.js';
import { stringifyJsonLine } from '../render/sanitize.js';
import type { KeychainStore } from '../secrets/keychain.js';

import {
  DIR_MODE,
  FILE_MODE,
  HEX_DIGEST,
  ISO_TIME,
  readRegularFile,
  sameDigest,
  statState,
} from './file-state.js';
import {
  COMMAND_WRITE_MARKS_FILE,
  latestWriteMark,
  readWriteMarks,
  recordUnkeyedWriteMark,
  recordWriteMark,
  removeWriteMarks,
} from './write-marks.js';

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
 * created with the owner-only mode `0600` from its first byte, one bounded record per write with a LEADING newline (so a process
 * killed mid-append cannot weld its partial line onto the next record), the mode self-healed on every write, NO lock, and
 * append-only with tombstones. The file is opened WITHOUT following a symlink and without blocking (where the platform has those
 * flags; a symlink is refused on every platform by an `lstat`), and only a regular file is read or written.
 *
 * **Who can do what.** A grant record carries a MAC over all of its fields under the installation key, so a grant cannot be forged,
 * relabelled, or minted under a new `id` from a copied record without the key. A `revoked` line cancels the grant with that id
 * wherever it sits in the file (a replayed or reordered grant line stays revoked), and two records for one argv are ONE grant that
 * one revoke withdraws. Tombstones are NOT authenticated: a process running as the same user can delete a tombstone line and bring
 * its grant back, and can restore an older copy of the file. `revoke --all` therefore also deletes the key, so a restored copy
 * stops validating. Nothing here defends against a same-user process that can read the keychain.
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
/** A tombstone is about 110 bytes; this is what a write reserves for the one that will withdraw a grant it makes room for. */
const TOMBSTONE_BYTES_BOUND = 256;
const ROOT_TAG = 'relavium/command-grants/root/v1';
const GRANT_TAG = 'relavium/command-grants/grant/v1';
const RECORD_TAG = 'relavium/command-grants/record/v1';
/** `argv[0]` may be named in a label only when it is this shape AND resolves on the PATH (ADR-0118 §2): it is free text otherwise. */
const BARE_PROGRAM = /^[A-Za-z0-9._+-]{1,64}$/u;
/** What a label says when the program cannot be named without risking a credential. */
export const UNNAMED_PROGRAM = '(unnamed program)';

/** What `toISOString()` writes. A free-text time would let a hand-edited line put a newline or an escape into a listing. */
const IsoTime = z.string().regex(ISO_TIME);

const GrantRecordSchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(/^[0-9a-zA-Z-]{1,64}$/u),
    root: z.string().regex(HEX_DIGEST),
    grant: z.string().regex(HEX_DIGEST),
    program: z.string().regex(BARE_PROGRAM).optional(),
    args: z.number().int().min(0).max(100_000),
    at: IsoTime,
    /** HMAC over every other field under the installation key: see {@link grantRecordMac}. */
    mac: z.string().regex(HEX_DIGEST),
  })
  .strict();
type GrantRecord = z.infer<typeof GrantRecordSchema>;

const TombstoneSchema = z
  .object({
    v: z.literal(1),
    revoked: z.string().regex(/^[0-9a-zA-Z-]{1,64}$/u),
    at: IsoTime,
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

/** Where a remembered grant stands against the file writes recorded for its root (ADR-0138). */
export type GrantStanding = 'none' | 'fresh' | 'stale';

/** Why the store cannot answer or accept a grant right now. */
export type CommandGrantUnavailable =
  /** The OS keychain is absent, locked, denied or holds an unusable entry, or a first write could not store the new key: no grant can be verified or written. */
  | 'no-key'
  /** A line did not parse, or the file passes a bound: the whole store reads as "no grants". */
  | 'unreadable'
  /** The directory or file cannot be written safely (a symlink, a permission). */
  | 'unwritable';

export type RememberResult =
  | { readonly ok: true; readonly id: string; readonly alreadyRemembered: boolean }
  | { readonly ok: false; readonly reason: CommandGrantUnavailable | 'full' };

export type ListResult =
  | {
      readonly ok: true;
      readonly grants: readonly GrantSummary[];
      /**
       * How many well-formed records of the file this installation's key did not make (a reset keychain, a file from another machine):
       * they are ignored, so a list that shows nothing may be a list that cannot be verified, and the caller says so. Absent when none.
       */
      readonly ignored?: number;
    }
  | { readonly ok: false; readonly reason: CommandGrantUnavailable };

export type RevokeResult =
  | {
      readonly ok: true;
      readonly id: string;
      /** Every record the grant was written as (two processes remembering one argv at once leave twins): all are withdrawn. */
      readonly ids: readonly string[];
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
  /**
   * Where a remembered grant for this argv stands (ADR-0138): `none` (no live grant, or the store cannot answer), `fresh` (the grant
   * is newer than every file write recorded for this root: `auto` runs it unasked) or `stale` (a file write was recorded after the
   * grant was made, or the record of writes cannot be read: `auto` asks, and Remember renews it).
   */
  standing: (argv: readonly string[]) => GrantStanding;
  /**
   * Record that a file write was applied under this root, so a grant made before it asks again in `auto` (ADR-0138). `false` when it
   * could not be recorded (told once through `notify`); a store with no key yet has no grant to protect and says `true`.
   */
  noteFileWrite: () => boolean;
  /** Whether Remember can be offered right now: the key is usable, the file is readable and writable, and a bound has room. */
  canRemember: (
    argv?: readonly string[],
  ) =>
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: CommandGrantUnavailable | 'full' };
  /** Persist a grant for this exact argv. Idempotent: an existing live grant is reported, not duplicated. */
  remember: (argv: readonly string[]) => Promise<RememberResult>;
  /** This root's live grants, in file order. */
  list: () => ListResult;
  /** Withdraw the grant at the 1-based index of {@link list} by appending a tombstone. */
  revoke: (index: number) => RevokeResult;
  /**
   * Withdraw the grant that CONTAINS this record `id` (a listed grant's `id`, or the id of one of its twins), appending a
   * tombstone for every record of it. Unlike {@link revoke} it names an identity, not a position, so a list read a moment ago
   * cannot make it withdraw a different grant: a grant that is gone is `no-such-grant`.
   */
  revokeById: (id: string) => RevokeResult;
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

/**
 * HMAC-SHA256 over a version tag and every field of a grant record (the fields cannot contain NUL, so joining them with it is
 * unambiguous). A record minted without the key, or relabelled, or copied under a new `id`, fails this check and is ignored.
 */
export function grantRecordMac(key: Buffer, record: Omit<GrantRecord, 'mac'>): string {
  return createHmac('sha256', key)
    .update(
      [
        RECORD_TAG,
        record.id,
        record.root,
        record.grant,
        record.program ?? '',
        String(record.args),
        record.at,
      ].join('\0'),
      'utf8',
    )
    .digest('hex');
}

/** A live grant, with the ids of any OTHER records for the same argv (two processes that remembered it at the same moment). */
interface LiveGrant extends GrantRecord {
  readonly twins: readonly string[];
  /** The latest `at` among the grant's records: a renewal (Remember again after a file write) is a twin with a later time. */
  readonly renewedAt: string;
}

interface Fold {
  /** Live grants in file order, one per argv. */
  readonly grants: readonly LiveGrant[];
  /** Well-formed grant records whose MAC did not verify under the key (ignored). */
  readonly foreign: number;
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
  const reported = new Set<string>();

  /** Told once per distinct message: a transient first failure must not use up the notice for a later, persistent one. */
  const report = (message: string): void => {
    if (reported.has(message)) return;
    reported.add(message);
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

  /** The grants file as text, through the one discipline both permission files share ({@link readRegularFile}); a refusal is told once. */
  const readText = ():
    | { readonly text: string; readonly bytes: number }
    | 'absent'
    | 'unreadable' => {
    const read = readRegularFile(path, COMMAND_GRANT_LIMITS.bytes);
    if (read.kind === 'absent') return 'absent';
    if (read.kind === 'refused') {
      report(unreadableMessage(path, read.why, read.byHand ? REMOVE_BY_HAND : REVOKE_ALL_HINT));
      return 'unreadable';
    }
    return { text: read.text, bytes: read.bytes };
  };

  /**
   * Fold the file. With a `key`, a grant record counts only if its MAC verifies; without one (no key yet, or none usable) no grant
   * counts, but the file is still parsed so an unreadable one is still reported. A line that is not exactly a grant or a
   * revocation fails the whole store; a well-formed grant with a bad MAC is merely ignored (it may be from an overwritten key).
   */
  const readFold = (key: Buffer | undefined): ReadFold => {
    const read = readText();
    if (read === 'absent')
      return { ok: true, fold: { grants: [], foreign: 0, lines: 0, bytes: 0 } };
    if (read === 'unreadable') return { ok: false };
    const parsed = parseGrantLines(read.text, path, key);
    if (!parsed.ok) {
      report(parsed.message);
      return { ok: false };
    }
    if (parsed.foreign > 0) {
      report(
        `${String(parsed.foreign)} record(s) in ${path} were not made with this installation's key and are ignored; \`relavium permissions revoke --all\` removes the file and the key.`,
      );
    }
    const grants = foldGrants(parsed.records, parsed.revoked);
    if (!withinGrantBounds(grants)) {
      report(unreadableMessage(path, 'it has more grants than the bound'));
      return { ok: false };
    }
    return {
      ok: true,
      fold: { grants, foreign: parsed.foreign, lines: parsed.lines, bytes: read.bytes },
    };
  };

  const rootGrants = (fold: Fold, root: string): readonly LiveGrant[] =>
    fold.grants.filter((grant) => sameDigest(grant.root, root));

  const matches = (argv: readonly string[]): boolean => {
    if (argv.length === 0) return false; // a call always names a program
    const state = readKey();
    if (state.kind !== 'ready') return false;
    const folded = readFold(state.key);
    if (!folded.ok) return false;
    const root = rootDigest(state.key, canonical);
    const candidate = grantDigest(state.key, root, argv);
    return rootGrants(folded.fold, root).some((grant) => sameDigest(grant.grant, candidate));
  };

  const marksPath = join(dirname(path), COMMAND_WRITE_MARKS_FILE);

  /**
   * Where a grant made at `renewedAt` stands against the writes recorded for its root (ADR-0138): `fresh`, `stale` (a write was
   * recorded after it, in this root or keyless), or `unreadable` (the file of marks cannot be read, told once: without it nothing says
   * no write happened, so the grant counts as stale and nothing can renew it).
   */
  const markState = (
    key: Buffer,
    root: string,
    renewedAt: string,
  ): 'fresh' | 'stale' | 'unreadable' => {
    const marks = readWriteMarks(marksPath, key);
    if (marks.kind === 'absent') return 'fresh';
    if (marks.kind === 'unreadable') {
      report(
        `The write-mark file ${marksPath} was ignored (${marks.why}); remembered commands will ask again in auto mode until it is repaired. ${REVOKE_ALL_HINT}`,
      );
      return 'unreadable';
    }
    const renewed = Date.parse(renewedAt);
    // A write applied while the keychain was unavailable could not be signed for a root: it outdates every grant older than it.
    if (marks.unkeyedMs !== undefined && !(renewed > marks.unkeyedMs)) return 'stale';
    const latest = latestWriteMark(marks.marks, root);
    return latest !== undefined && !(renewed > latest) ? 'stale' : 'fresh';
  };

  const standing = (argv: readonly string[]): GrantStanding => {
    if (argv.length === 0) return 'none';
    const state = readKey();
    if (state.kind !== 'ready') return 'none';
    const folded = readFold(state.key);
    if (!folded.ok) return 'none';
    const root = rootDigest(state.key, canonical);
    const candidate = grantDigest(state.key, root, argv);
    const grant = rootGrants(folded.fold, root).find((record) =>
      sameDigest(record.grant, candidate),
    );
    if (grant === undefined) return 'none';
    return markState(state.key, root, grant.renewedAt) === 'fresh' ? 'fresh' : 'stale';
  };

  const noteFileWrite = (): boolean => {
    // Afresh, like a Remember: a chat that cached a key the keychain has since replaced would otherwise sign a mark nothing verifies.
    keyState = undefined;
    const state = readKey();
    // No key yet means no grant was ever made on this machine, and a grant made later is newer than this write.
    if (state.kind === 'absent') return true;
    if (state.kind === 'unavailable') {
      // The grants made earlier verify again when the keychain answers, so this write must still outdate them: no key means no root
      // digest and no MAC, so it is recorded as one unauthenticated time that outdates every older grant (ADR-0138 §5).
      const unkeyed = recordUnkeyedWriteMark(marksPath, now());
      if (unkeyed.ok) {
        report(
          'A file write was recorded without the keychain, which is not available: remembered commands made before it ask again in auto mode.',
        );
        return true;
      }
      report(
        unkeyed.reason === 'unreadable'
          ? `A file write could not be recorded for remembered commands: ${marksPath} cannot be read. They ask again in auto mode in this chat only. ${REVOKE_ALL_HINT}`
          : `A file write could not be recorded for remembered commands: ${marksPath} cannot be written. They ask again in auto mode in this chat only.`,
      );
      return false;
    }
    const result = recordWriteMark(marksPath, state.key, rootDigest(state.key, canonical), now());
    if (result.ok) return true;
    report(
      result.reason === 'unreadable'
        ? `A file write could not be recorded for remembered commands: ${marksPath} cannot be read. They ask again in auto mode in this chat only. ${REVOKE_ALL_HINT}`
        : `A file write could not be recorded for remembered commands: ${marksPath} cannot be written. They ask again in auto mode in this chat only.`,
    );
    return false;
  };

  /**
   * Whether the store has room for one more record. A renewal (a record for an argv that already has a live grant) adds no grant:
   * only the line and size bounds apply to it, so a root with 64 grants can still renew one.
   */
  const room = (
    fold: Fold,
    root: string,
    renewal = false,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: 'full' } => {
    if (
      fold.lines + 2 > COMMAND_GRANT_LIMITS.lines ||
      fold.bytes + RECORD_BYTES_BOUND + TOMBSTONE_BYTES_BOUND > COMMAND_GRANT_LIMITS.bytes ||
      (!renewal &&
        (fold.grants.length >= COMMAND_GRANT_LIMITS.total ||
          rootGrants(fold, root).length >= COMMAND_GRANT_LIMITS.perRoot))
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
    const info = statState(path);
    if (info === 'error') return false;
    try {
      if (info !== undefined) {
        if (info.isSymbolicLink() || !info.isFile()) return false;
        accessSync(path, constants.W_OK);
        return true;
      }
      const directory = statState(dirname(path));
      accessSync(directory === undefined ? deps.homeDir : dirname(path), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  const canRemember = (argv?: readonly string[]): ReturnType<CommandGrantStore['canRemember']> => {
    const state = readKey();
    // An absent key can be generated at the first write; an unusable keychain cannot. The write path re-checks.
    if (state.kind === 'unavailable') return { ok: false, reason: 'no-key' };
    const folded = readFold(state.kind === 'ready' ? state.key : undefined);
    if (!folded.ok) return { ok: false, reason: 'unreadable' };
    if (!writable()) return { ok: false, reason: 'unwritable' };
    // While the marks cannot be read every grant reads as stale, so a Remember would add a record that cannot make anything fresh:
    // not offered (the notice that says why comes from the read).
    if (state.kind === 'ready' && readWriteMarks(marksPath, state.key).kind === 'unreadable') {
      return { ok: false, reason: 'unreadable' };
    }
    const root = state.kind === 'ready' ? rootDigest(state.key, canonical) : '0'.repeat(64); // no grants can exist without a key
    // Renewing a grant adds no grant (a twin folds into it): only the line and size bounds apply, as in `remember`.
    const renewal =
      state.kind === 'ready' &&
      argv !== undefined &&
      argv.length > 0 &&
      rootGrants(folded.fold, root).some((record) =>
        sameDigest(record.grant, grantDigest(state.key, root, argv)),
      );
    return room(folded.fold, root, renewal);
  };

  const remember = async (argv: readonly string[]): Promise<RememberResult> => {
    if (argv.length === 0) throw new RangeError('a command grant needs a program');
    // The only await comes first: from the read of the file to the append nothing yields, so two calls in one process cannot both
    // pass the "already remembered" check. Two PROCESSES still can; the fold treats the two records as one grant.
    const program = await namedProgram(argv[0], findProgram);
    // A write reads the keychain afresh: another process may have cleared the key (`revoke --all`) since this store cached it, and a
    // grant signed with the cached key would be reported as remembered and never match again.
    keyState = undefined;
    // Look before generating anything: an unusable keychain or an unreadable file must not leave a new key behind.
    const state = readKey();
    if (state.kind === 'unavailable') return { ok: false, reason: 'no-key' };
    const folded = readFold(state.kind === 'ready' ? state.key : undefined);
    if (!folded.ok) return { ok: false, reason: 'unreadable' };
    const key = ensureKey();
    if (key === undefined) return { ok: false, reason: 'no-key' };
    const root = rootDigest(key, canonical);
    const grant = grantDigest(key, root, argv);
    const existing = rootGrants(folded.fold, root).find((record) =>
      sameDigest(record.grant, grant),
    );
    // A grant that stands as it is is reported, not duplicated. One that a recorded file write has outdated is renewed: a new record
    // for the same argv (a twin, folded into the one grant) dated now, so `auto` runs it unasked again.
    const mark = existing === undefined ? 'fresh' : markState(key, root, existing.renewedAt);
    if (existing !== undefined && mark === 'fresh') {
      return { ok: true, id: existing.id, alreadyRemembered: true };
    }
    // A renewal that nothing can make fresh (the marks cannot be read) is refused, not reported as remembered.
    if (mark === 'unreadable') return { ok: false, reason: 'unreadable' };
    const space = room(folded.fold, root, existing !== undefined);
    if (!space.ok) return space;
    const fields: Omit<GrantRecord, 'mac'> = {
      v: 1,
      id: newId(),
      root,
      grant,
      ...(program === undefined ? {} : { program }),
      args: Math.max(0, argv.length - 1),
      at: now().toISOString(),
    };
    const record: GrantRecord = { ...fields, mac: grantRecordMac(key, fields) };
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
    const folded = readFold(state.kind === 'ready' ? state.key : undefined);
    if (!folded.ok) return { ok: false, reason: 'unreadable' };
    // No key yet means no grant was ever written under this machine's key: the honest answer is an empty list, not a fault.
    if (state.kind === 'absent') {
      return {
        ok: true,
        grants: [],
        ...(folded.fold.foreign > 0 ? { ignored: folded.fold.foreign } : {}),
      };
    }
    const root = rootDigest(state.key, canonical);
    return {
      ok: true,
      ...(folded.fold.foreign > 0 ? { ignored: folded.fold.foreign } : {}),
      grants: rootGrants(folded.fold, root).map((grant, offset) => ({
        index: offset + 1,
        id: grant.id,
        program: grant.program ?? UNNAMED_PROGRAM,
        args: grant.args,
        grantedAt: grant.renewedAt,
      })),
    };
  };

  /** Withdraw the live grant `select` picks from this root's grants: one tombstone per record of it (the grant and its twins). */
  const withdraw = (
    select: (
      grants: ReturnType<typeof rootGrants>,
    ) => ReturnType<typeof rootGrants>[number] | undefined,
  ): RevokeResult => {
    const state = readKey();
    if (state.kind === 'unavailable') return { ok: false, reason: 'no-key' };
    const folded = readFold(state.kind === 'ready' ? state.key : undefined);
    if (!folded.ok) return { ok: false, reason: 'unreadable' };
    if (state.kind === 'absent') return { ok: false, reason: 'no-such-grant' };
    const target = select(rootGrants(folded.fold, rootDigest(state.key, canonical)));
    if (target === undefined) return { ok: false, reason: 'no-such-grant' };
    const ids = [target.id, ...target.twins];
    // A tombstone is a line too. Remember leaves room for one (see `room`), but a store at its bound cannot take another line:
    // better to say so than to push the file past the bound, where every grant in it would read as "no grants".
    if (
      folded.fold.lines + ids.length > COMMAND_GRANT_LIMITS.lines ||
      folded.fold.bytes + ids.length * TOMBSTONE_BYTES_BOUND > COMMAND_GRANT_LIMITS.bytes
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
      ids,
      program: target.program ?? UNNAMED_PROGRAM,
      args: target.args,
    };
  };

  const revoke = (index: number): RevokeResult => withdraw((grants) => grants[index - 1]);

  const revokeById = (id: string): RevokeResult =>
    withdraw((grants) => grants.find((grant) => grant.id === id || grant.twins.includes(id)));

  const revokeAll = (): RevokeAllResult => removeCommandGrantsFile(deps.homeDir, deps.keychain);

  return {
    matches,
    standing,
    noteFileWrite,
    canRemember,
    remember,
    list,
    revoke,
    revokeById,
    revokeAll,
  };
}

/**
 * Remove the whole file, for every project, and (best effort) the digest key: the recovery that needs no project root and no
 * readable file. Deleting the key is what makes a restored older copy of the file stop validating, and it clears an unusable
 * keychain entry; a keychain that cannot be reached is ignored, because the file is gone either way. A file that cannot be
 * removed is a failure, never "nothing to remove" (and then the key is kept, so the grants still verify). An unlink removes a
 * symlink itself, not what it points at.
 */
export function removeCommandGrantsFile(
  homeDir: string,
  keychain?: KeychainStore,
): RevokeAllResult {
  const path = commandGrantsPath(homeDir);
  // The write marks are keyed by the same installation key, so they are of no use without the grants; best effort, like the key, and
  // only once the grants are gone: a removal that fails must not leave the grants standing with the marks that outdate them gone.
  const forgetMarks = (): void => {
    removeWriteMarks(join(dirname(path), COMMAND_WRITE_MARKS_FILE));
  };
  const forgetKey = (): void => {
    try {
      keychain?.delete(COMMAND_GRANTS_KEY_ACCOUNT);
    } catch {
      // Locked or absent: nothing was written to a file, and the grants are gone with it.
    }
  };
  if (statState(path) === undefined) {
    forgetMarks();
    forgetKey();
    return { ok: true, removed: false };
  }
  try {
    unlinkSync(path);
  } catch {
    // Lost a race with another remover, or a refusal: only the file's absence now tells them apart.
    if (statState(path) !== undefined) return { ok: false, reason: 'unwritable' };
    forgetMarks();
    forgetKey();
    return { ok: true, removed: false };
  }
  forgetMarks();
  forgetKey();
  return { ok: true, removed: true };
}

const REVOKE_ALL_HINT = '`relavium permissions revoke --all` removes it.';
const REMOVE_BY_HAND = 'Remove it by hand.';

/** One line of the grants file, classified: a revocation, a grant whose MAC verifies, a record this key did not make, or a line that is neither. */
type ParsedGrantLine =
  | { readonly kind: 'revocation'; readonly id: string }
  | { readonly kind: 'grant'; readonly record: GrantRecord }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'invalid'; readonly why: string };

function parseGrantLine(line: string, key: Buffer | undefined): ParsedGrantLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: 'invalid', why: 'a line does not parse' };
  }
  const tombstone = TombstoneSchema.safeParse(raw);
  if (tombstone.success) return { kind: 'revocation', id: tombstone.data.revoked };
  const grant = GrantRecordSchema.safeParse(raw);
  if (!grant.success) return { kind: 'invalid', why: 'a line is not a grant or a revocation' };
  // No key, so nothing in the file can be verified: counted, and told like any record this key did not make.
  if (key === undefined) return { kind: 'foreign' };
  const { mac, ...fields } = grant.data;
  return sameDigest(mac, grantRecordMac(key, fields))
    ? { kind: 'grant', record: grant.data }
    : { kind: 'foreign' };
}

type ParsedGrantLines =
  | {
      readonly ok: true;
      readonly records: ReadonlyMap<string, GrantRecord>;
      readonly revoked: ReadonlySet<string>;
      readonly lines: number;
      readonly foreign: number;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The file's lines folded into records and revocations. A line that is not exactly a grant or a revocation, or a file over the line
 * bound, fails the whole store (the message says why); a well-formed grant with a bad MAC is only counted as foreign (it may be from an
 * overwritten key). The first record of an id wins.
 */
function parseGrantLines(text: string, path: string, key: Buffer | undefined): ParsedGrantLines {
  const records = new Map<string, GrantRecord>();
  const revoked = new Set<string>();
  let lines = 0;
  let foreign = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue; // the leading-newline framing and a trailing terminator
    lines += 1;
    if (lines > COMMAND_GRANT_LIMITS.lines)
      return { ok: false, message: unreadableMessage(path, 'it has more lines than the bound') };
    const parsed = parseGrantLine(line, key);
    switch (parsed.kind) {
      case 'invalid':
        return { ok: false, message: unreadableMessage(path, parsed.why) };
      case 'revocation':
        revoked.add(parsed.id);
        break;
      case 'foreign':
        foreign += 1;
        break;
      case 'grant':
        if (!records.has(parsed.record.id)) records.set(parsed.record.id, parsed.record);
        break;
    }
  }
  return { ok: true, records, revoked, lines, foreign };
}

/**
 * The live grants of the records. Revocation does not depend on file order: a replayed or reordered grant line stays revoked. Two live
 * records for one argv are one grant (the first is kept, the other ids are its twins, so revoking it withdraws both, and a renewal is
 * the latest of them).
 */
function foldGrants(
  records: ReadonlyMap<string, GrantRecord>,
  revoked: ReadonlySet<string>,
): LiveGrant[] {
  const byDigest = new Map<string, { record: GrantRecord; twins: string[]; renewedMs: number }>();
  for (const record of records.values()) {
    if (revoked.has(record.id)) continue;
    const identity = `${record.root}:${record.grant}`;
    const seen = byDigest.get(identity);
    const ms = Date.parse(record.at);
    if (seen === undefined) byDigest.set(identity, { record, twins: [], renewedMs: ms });
    else {
      seen.twins.push(record.id);
      if (ms > seen.renewedMs) seen.renewedMs = ms;
    }
  }
  return [...byDigest.values()].map(
    ({ record, twins, renewedMs }): LiveGrant => ({
      ...record,
      twins,
      renewedAt: Number.isNaN(renewedMs) ? record.at : new Date(renewedMs).toISOString(),
    }),
  );
}

/** Whether the grants are within the file's bounds: in all, and per project root. */
function withinGrantBounds(grants: readonly LiveGrant[]): boolean {
  if (grants.length > COMMAND_GRANT_LIMITS.total) return false;
  const perRoot = new Map<string, number>();
  for (const grant of grants) perRoot.set(grant.root, (perRoot.get(grant.root) ?? 0) + 1);
  return ![...perRoot.values()].some((count) => count > COMMAND_GRANT_LIMITS.perRoot);
}

function unreadableMessage(path: string, why: string, recovery: string = REVOKE_ALL_HINT): string {
  return `The remembered-command file ${path} was ignored (${why}); remembered commands will ask again. ${recovery}`;
}

/** The program's bare name, only when it is a bare name that resolves on the PATH; else `undefined` (ADR-0118 §2). */
export async function namedProgram(
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

/** The sentence the append's refusal of a link, or of a path that cannot be inspected, carries. */
const REFUSED_LINK_OR_UNINSPECTABLE =
  'the remembered-command file cannot be inspected or is a symbolic link; refusing to write';
const REFUSED_HARD_LINK =
  'the remembered-command file has more than one hard link; refusing to write to it';
/** This store's own sentence for each way the shared append refuses its target. */
const APPEND_REFUSAL_SENTENCES: Readonly<Record<AppendTargetRefusedError['reason'], string>> = {
  symlink: REFUSED_LINK_OR_UNINSPECTABLE,
  'hard-link': REFUSED_HARD_LINK,
  'not-regular': 'the remembered-command file is not a regular file',
};

/**
 * One record, one write, with a LEADING newline (a process killed mid-append leaves a partial last line with no terminator, and
 * appending straight onto it would weld two records into one corrupt line, which the fail-closed fold would turn into "no
 * grants" for the whole machine). The check by path here refuses a link or a path that cannot be inspected before anything is
 * opened; the append itself is the CLI's shared single-descriptor one ({@link appendToOwnerOnlyFile}): the file is created with the
 * owner-only mode from its FIRST byte, opened without following a symlink and without blocking where the platform allows, and checked
 * on the descriptor to be a regular file, so a path swapped for a link or a FIFO after the read is neither written through nor waited
 * on. Its refusals keep this store's own sentences.
 */
function appendLine(path: string, record: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const seen = statState(path);
  if (seen === 'error' || seen?.isSymbolicLink() === true)
    throw new Error(REFUSED_LINK_OR_UNINSPECTABLE);
  try {
    appendToOwnerOnlyFile(path, `\n${stringifyJsonLine(record)}\n`, FILE_MODE);
  } catch (error) {
    if (!(error instanceof AppendTargetRefusedError)) throw error;
    throw new Error(APPEND_REFUSAL_SENTENCES[error.reason]);
  }
}
