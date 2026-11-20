import { scrubbedCommandDisplay } from '@relavium/core';

import type { SessionCommandApproval } from '../chat/chat-mode.js';
import { sanitizeInline } from '../render/sanitize.js';
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

export interface PermissionsDeps {
  /** The project's remembered grants, `undefined` where the surface has none (no operator home, or one that cannot ask). */
  readonly grants: Pick<CommandGrantStore, 'list' | 'revokeById' | 'matches'> | undefined;
  /** This chat's session approvals; `undefined` on a surface with no chat (the bare Home, a bare `relavium permissions`). */
  readonly session: SessionCommandApprovals | undefined;
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

/** What a host hands the sheet: the data read now, and a withdrawal carried out (the store is read again there). */
export interface PermissionsPort {
  /** A chat lists the session's approvals too; the bare Home and a bare `relavium permissions` list the project's only. */
  readonly surface: 'chat' | 'project';
  readonly load: () => PermissionsSnapshot;
  /** Withdraw the row and return the one-line answer; it never throws, and says what happened when it could not. */
  readonly withdraw: (entry: PermissionEntry) => string;
}

export type ProjectPermissions =
  | { readonly ok: true; readonly rows: readonly ProjectGrantRow[] }
  /** The store cannot answer: the section says why, in a fixed sentence, instead of rows. */
  | { readonly ok: false; readonly text: string };

export interface PermissionsSnapshot {
  readonly project: ProjectPermissions;
  /** `undefined` where there is no chat: the sheet then has no session section. */
  readonly session: readonly SessionApprovalRow[] | undefined;
}

const plural = (count: number): string =>
  `${String(count)} ${count === 1 ? 'argument' : 'arguments'}`;

/** The fixed sentences for a store that cannot answer or accept a write; none carries a path or a command. */
export const PROJECT_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  'no-key': 'The OS keychain is not available, so the remembered commands cannot be read.',
  unreadable:
    'The remembered-commands file could not be read, so nothing in it is trusted. `relavium permissions revoke --all` removes it.',
  unwritable: 'The remembered-commands file could not be written, so nothing was withdrawn.',
  full: 'The remembered-commands file has no room for a withdrawal. `relavium permissions revoke --all` removes it.',
});

/** The same reasons for the sheet's one-row message, where a withdrawal could not be made: short enough to be read whole at 80 columns. */
const WITHDRAW_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  'no-key': 'The OS keychain is not available.',
  unreadable: 'The remembered-commands file could not be read.',
  unwritable: 'Could not write the withdrawal; nothing changed.',
  full: 'No room in the file for a withdrawal; revoke --all clears it.',
});

const FALLBACK_FAILURE = 'The remembered commands could not be read.';
export const NOT_AVAILABLE = 'Remembered commands are not available in this chat.';

/** `2026-11-19T14:03:21.123Z` → `2026-11-19 14:03Z`; a value of another shape is shown as it is, sanitized (the store validates it already). */
function rememberedAt(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec(iso);
  return match === null ? sanitizeInline(iso) : `${match[1] ?? ''} ${match[2] ?? ''}Z`;
}

/** The sheet's data, read now. Synchronous: the store and the cache are both in this process. */
export function readPermissions(deps: PermissionsDeps): PermissionsSnapshot {
  let project: ProjectPermissions;
  if (deps.grants === undefined) {
    project = { ok: false, text: NOT_AVAILABLE };
  } else {
    const listed = deps.grants.list();
    project = listed.ok
      ? {
          ok: true,
          rows: listed.grants.map((grant) => ({
            id: grant.id,
            label: `${sanitizeInline(grant.program)}, ${plural(grant.args)}`,
            remembered: rememberedAt(grant.grantedAt),
          })),
        }
      : { ok: false, text: PROJECT_FAILURES[listed.reason] ?? FALLBACK_FAILURE };
  }
  const session = deps.session?.commandApprovals().map(
    (approval): SessionApprovalRow => ({
      argv: approval.argv,
      text: sanitizeInline(scrubbedCommandDisplay(approval.argv)),
      alsoRemembered: approval.remembered || deps.grants?.matches(approval.argv) === true,
    }),
  );
  return { project, session };
}

/**
 * Take a remembered command back, by the grant's identity. The message says what was withdrawn and what that changes, and never claims an
 * effect that depends on the mode the chat is in: only `auto` ever ran a remembered command unasked, so it is `auto` that asks again.
 */
export function withdrawProjectGrant(row: ProjectGrantRow, deps: PermissionsDeps): string {
  if (deps.grants === undefined) return NOT_AVAILABLE;
  const result = deps.grants.revokeById(row.id);
  if (!result.ok) {
    if (result.reason === 'no-such-grant') return 'That row was already withdrawn.';
    return WITHDRAW_FAILURES[result.reason] ?? FALLBACK_FAILURE;
  }
  // A Remember in this chat also left a session approval; it goes with the grant, or the command would keep running unasked here.
  let dropped = 0;
  for (const id of result.ids) dropped += deps.session?.forgetCommandsByGrant?.(id) ?? 0;
  return `Withdrew ${row.label}. Auto mode asks about it again.${dropped > 0 ? ' Its session approval went too.' : ''}`;
}

/** Take a session approval back, by its exact argv. */
export function withdrawSessionApproval(row: SessionApprovalRow, deps: PermissionsDeps): string {
  const gone = deps.session?.forgetCommandApproval(row.argv);
  if (gone === undefined) return 'That row was already withdrawn.';
  // A remembered grant that covers the command keeps `auto` running it unasked, so the sentence says so instead of promising a question.
  const covered = gone.remembered || deps.grants?.matches(gone.argv) === true;
  return covered
    ? 'Session approval withdrawn. Still remembered: auto mode runs it unasked.'
    : 'Session approval withdrawn. Auto mode asks about it again.';
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
