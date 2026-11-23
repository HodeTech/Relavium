import { scrubbedCommandDisplay } from '@relavium/core';

import type { SessionCommandApproval } from '../chat/chat-mode.js';
import type { CommandGrantStore } from './command-grants.js';

/**
 * What the `/permissions` sheet knows about the commands a person approved ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2, over [ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2): the commands remembered
 * for this project and the ones approved for this session, and taking one back. It builds the rows and the sentences; it draws nothing and
 * writes nothing to a terminal, so it cannot print anything it did not build here.
 *
 * A remembered row is a label only: the store keeps a keyed digest, never the command, so it can say a program's name (only where it could
 * be named without risking a credential), the argument count and when it was remembered. A session approval is in memory and was shown in
 * full on the card that approved it, so its row shows the command through the same scrub the card's title uses.
 */

/** What the sheet needs of the session's approvals: list them and take one back by its exact argv (the key the cache uses). */
export interface SessionCommandApprovals {
  readonly commandApprovals: () => readonly SessionCommandApproval[];
  readonly forgetCommandApproval: (argv: readonly string[]) => SessionCommandApproval | undefined;
  /** Take back the session approvals a Remember created for this remembered grant; how many were withdrawn. */
  readonly forgetCommandsByGrant?: (grantId: string) => number;
}

/** What the repository's `[chat]` allowlist says, as the config resolves it: the exact entries and the opt-in glob patterns, either of them absent. */
export interface RepoAllowlistSource {
  readonly commands: readonly string[] | undefined;
  readonly globs: readonly string[] | undefined;
}

export interface PermissionsDeps {
  /** The project's remembered grants, `undefined` where the surface has none (no operator home, or one that cannot ask). */
  readonly grants: Pick<CommandGrantStore, 'list' | 'revokeById' | 'matches'> | undefined;
  /** This chat's session approvals; `undefined` on a surface with no chat (the bare Home, a bare `relavium permissions`). */
  readonly session: SessionCommandApprovals | undefined;
  /**
   * The repository's `[chat]` allowlist, read now, for a surface that lists it (the Home's Permissions tab, ADR-0140 §3); `undefined`
   * on one that does not (a chat's own sheet). It may throw: the snapshot then says the allowlist could not be read.
   */
  readonly allowlist?: (() => RepoAllowlistSource) | undefined;
}

/** A remembered command as the sheet lists it: held by the grant's `id`, shown by its label and when it was remembered. */
export interface ProjectGrantRow {
  readonly id: string;
  /** `npm, 1 argument`, or `(unnamed program), 2 arguments`. */
  readonly label: string;
  /** `2026-11-19 14:03Z`: the minute, so two grants of one program on one day can be told apart. */
  readonly remembered: string;
}

/** A command approved for this session as the sheet lists it: held by its exact argv, shown scrubbed. */
export interface SessionApprovalRow {
  readonly argv: readonly string[];
  /** The command as the card's title showed it, quoted and scrubbed. */
  readonly text: string;
  /** A Remember made it, or a remembered grant covers it now: `auto` still runs it unasked after this row is withdrawn. */
  readonly alsoRemembered: boolean;
}

/** One selectable row of the sheet: a remembered command or a session approval. */
export type PermissionEntry =
  | { readonly kind: 'project'; readonly row: ProjectGrantRow }
  | { readonly kind: 'session'; readonly row: SessionApprovalRow };

/**
 * What a withdrawal says: a sentence and how to draw it. `done` is a withdrawal made (a `✓`, in the success colour), `failed` is one that could
 * not be made (a `✗`, in the danger colour), `note` is what the person needs to know and is neither: a row that was already gone, a withdrawal
 * that left a session approval standing. The glyph is the sheet's; the sentence carries none, so a screen reader reads the words once.
 */
export type WithdrawTone = 'done' | 'failed' | 'note';

export interface WithdrawAnswer {
  readonly tone: WithdrawTone;
  readonly text: string;
}

const done = (text: string): WithdrawAnswer => ({ tone: 'done', text });
const failed = (text: string): WithdrawAnswer => ({ tone: 'failed', text });
const note = (text: string): WithdrawAnswer => ({ tone: 'note', text });

/** What a host hands the sheet: the data read now, and a withdrawal carried out (the store is read again there). */
export interface PermissionsPort {
  /** A chat lists the session's approvals too; the bare Home and a bare `relavium permissions` list the project's only. */
  readonly surface: 'chat' | 'project';
  readonly load: () => PermissionsSnapshot;
  /** Withdraw the row and return the one-line answer; it never throws, and says what happened when it could not. */
  readonly withdraw: (entry: PermissionEntry) => WithdrawAnswer;
}

export type ProjectPermissions =
  | { readonly ok: true; readonly rows: readonly ProjectGrantRow[] }
  /** The store cannot answer: the section says why, in a fixed sentence, instead of rows. */
  | { readonly ok: false; readonly text: string };

/**
 * The repository's `[chat]` allowlist as the Permissions tab lists it, read-only and bounded: at most {@link MAX_ALLOWLIST_ENTRIES} entries
 * of each list are kept, each cut to {@link MAX_ROW_TEXT} characters, and `omitted` counts what was not kept. It pre-approves nothing in a
 * chat ([ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1, amended 2026-11-21): the
 * file is the repository's, not the person's, so a listed command only says so on its card.
 */
export type RepoAllowlist =
  | {
      readonly ok: true;
      readonly commands: readonly string[];
      readonly globs: readonly string[];
      readonly omitted: number;
    }
  /** The config cannot answer: the section says so, in a fixed sentence, instead of rows. */
  | { readonly ok: false; readonly text: string };

export interface PermissionsSnapshot {
  readonly project: ProjectPermissions;
  /** `undefined` where there is no chat: the sheet then has no session section. */
  readonly session: readonly SessionApprovalRow[] | undefined;
  /** The repository's allowlist, for the surface that lists it; `undefined` where the surface does not (a chat's sheet). */
  readonly allowlist?: RepoAllowlist | undefined;
}

const plural = (count: number): string =>
  `${String(count)} ${count === 1 ? 'argument' : 'arguments'}`;

/** The fixed sentences for a store that cannot answer or accept a write; none carries a path or a command. */
export const PROJECT_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  'no-key': 'The OS keychain is not available, so the remembered commands cannot be read.',
  unreadable:
    'The remembered-commands file could not be read, so nothing in it is trusted. Running relavium permissions revoke --all removes it.',
  unwritable: 'The remembered-commands file could not be written, so nothing was withdrawn.',
  full: 'The remembered-commands file has no room for a withdrawal. Running relavium permissions revoke --all removes it.',
});

/** The same reasons for the sheet's one-row message, where a withdrawal could not be made: short enough to be read whole at 80 columns. */
const WITHDRAW_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  'no-key': 'The OS keychain is not available.',
  unreadable: 'The remembered-commands file could not be read.',
  unwritable: 'Could not write the withdrawal; nothing changed.',
  full: 'No room in the file; relavium permissions revoke --all clears it.',
});

const FALLBACK_FAILURE = 'The remembered commands could not be read.';
/** The fixed sentence for a config that cannot be read; it carries no path and no entry. */
export const ALLOWLIST_UNREADABLE = 'The repository’s [chat] allowlist could not be read.';
/** The most entries of each allowlist kept in a snapshot; a config can hold any number and the tab draws a handful. */
export const MAX_ALLOWLIST_ENTRIES = 50;
export const NOT_AVAILABLE = 'Remembered commands are not available in this chat.';

/** `2026-11-19T14:03:21.123Z` → `2026-11-19 14:03Z`; a value of another shape is passed on as it is (the store validates it already, and the sheet escapes what it draws). */
function rememberedAt(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec(iso);
  return match === null ? iso : `${match[1] ?? ''} ${match[2] ?? ''}Z`;
}

/** The most characters of a command a row keeps. A command can be a megabyte long; the sheet draws every row on every key, so the cut is made once, here. */
export const MAX_ROW_TEXT = 400;

function bounded(text: string): string {
  const characters = [...text];
  return characters.length <= MAX_ROW_TEXT
    ? text
    : `${characters.slice(0, MAX_ROW_TEXT - 1).join('')}…`;
}

/** The sheet's data, read now. Synchronous: the store and the cache are both in this process. It never throws: what cannot be read is said in a sentence. */
export function readPermissions(deps: PermissionsDeps): PermissionsSnapshot {
  let project: ProjectPermissions;
  if (deps.grants === undefined) {
    project = { ok: false, text: NOT_AVAILABLE };
  } else {
    try {
      const listed = deps.grants.list();
      project = listed.ok
        ? {
            ok: true,
            rows: listed.grants.map((grant) => ({
              id: grant.id,
              label: `${grant.program}, ${plural(grant.args)}`,
              remembered: rememberedAt(grant.grantedAt),
            })),
          }
        : { ok: false, text: PROJECT_FAILURES[listed.reason] ?? FALLBACK_FAILURE };
    } catch {
      project = { ok: false, text: FALLBACK_FAILURE };
    }
  }
  // The session list is not wrapped: a cache that threw would be a defect, and the host's guard says so (the sheet does not open) instead of
  // drawing an empty list that claims nothing is approved while approvals still run unasked.
  const session = deps.session?.commandApprovals().map(
    (approval): SessionApprovalRow => ({
      argv: approval.argv,
      // The command as the card's title showed it. Nothing is stripped from it here: the sheet shows a control, a bidi override or a
      // tab as a visible token, which a strip would have hidden.
      text: bounded(scrubbedCommandDisplay(approval.argv)),
      // Whether a remembered grant covers the command NOW: the only thing that keeps `auto` running it after the approval is withdrawn.
      alsoRemembered: deps.grants?.matches(approval.argv) === true,
    }),
  );
  return deps.allowlist === undefined
    ? { project, session }
    : { project, session, allowlist: readAllowlist(deps.allowlist) };
}

/** The allowlist, read now and bounded. Never throws: a config that cannot be read is said in a sentence, not drawn as an empty list. */
function readAllowlist(read: () => RepoAllowlistSource): RepoAllowlist {
  try {
    const source = read();
    const commands = source.commands ?? [];
    const globs = source.globs ?? [];
    return {
      ok: true,
      commands: commands.slice(0, MAX_ALLOWLIST_ENTRIES).map(bounded),
      globs: globs.slice(0, MAX_ALLOWLIST_ENTRIES).map(bounded),
      omitted:
        Math.max(0, commands.length - MAX_ALLOWLIST_ENTRIES) +
        Math.max(0, globs.length - MAX_ALLOWLIST_ENTRIES),
    };
  } catch {
    return { ok: false, text: ALLOWLIST_UNREADABLE };
  }
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((element, index) => element === b[index]);

/**
 * Take a remembered command back, by the grant's identity. The answer says what was withdrawn and what that changes, and says nothing a mode
 * could contradict: it names `auto` only for what `auto` does (a withdrawn grant no longer exempts a command there), and where a session
 * approval of the same command still stands it says that approval stands, because it keeps the command approved in every mode that asks.
 */
export function withdrawProjectGrant(row: ProjectGrantRow, deps: PermissionsDeps): WithdrawAnswer {
  const grants = deps.grants;
  if (grants === undefined) return failed(NOT_AVAILABLE);
  // The session approvals a grant covers, noted before it goes: the ones it covered are the ones that stop matching afterwards.
  const before = (deps.session?.commandApprovals() ?? []).filter((approval) =>
    grants.matches(approval.argv),
  );
  const result = grants.revokeById(row.id);
  if (!result.ok) {
    if (result.reason === 'no-such-grant') return note('That row was already withdrawn.');
    return failed(WITHDRAW_FAILURES[result.reason] ?? FALLBACK_FAILURE);
  }
  // A Remember in this chat also left a session approval; it goes with the grant, or the command would keep running unasked here.
  let dropped = 0;
  for (const id of result.ids) dropped += deps.session?.forgetCommandsByGrant?.(id) ?? 0;
  // The approvals THIS grant covered are those that matched before and match no more; of them, the ones still in the cache are plain
  // session approvals of the command, which the grant never owned. (An approval another grant covers matches still and is not this one's.)
  const covered = before.filter((approval) => !grants.matches(approval.argv));
  const remaining = (deps.session?.commandApprovals() ?? []).some((approval) =>
    covered.some((was) => sameArgv(was.argv, approval.argv)),
  );
  if (remaining)
    return note('Withdrawn, but a session approval of it remains: it is still approved here.');
  return dropped > 0
    ? done('Withdrawn, with its session approval. It needs approval again.')
    : done('Withdrawn. Auto mode asks about it again.');
}

/** Take a session approval back, by its exact argv. */
export function withdrawSessionApproval(
  row: SessionApprovalRow,
  deps: PermissionsDeps,
): WithdrawAnswer {
  // Asked before anything changes: a store that failed on the question must not leave "nothing changed" over a removed approval.
  const covered = deps.grants?.matches(row.argv) === true;
  const gone = deps.session?.forgetCommandApproval(row.argv);
  if (gone === undefined) return note('That row was already withdrawn.');
  // A remembered grant that covers the command keeps `auto` running it unasked, so the sentence says so instead of promising a question.
  return covered
    ? note('Session approval withdrawn. It is still remembered; auto may run it unasked.')
    : done('Session approval withdrawn. It needs approval again.');
}

/** The port a host opens the sheet with, over the store and the cache it already holds. */
export function createPermissionsPort(
  deps: PermissionsDeps,
  surface: 'chat' | 'project',
): PermissionsPort {
  return {
    surface,
    load: () => readPermissions(deps),
    withdraw: (entry) =>
      entry.kind === 'project'
        ? withdrawProjectGrant(entry.row, deps)
        : withdrawSessionApproval(entry.row, deps),
  };
}
