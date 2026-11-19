import type { SessionCommandApproval } from '../chat/chat-mode.js';
import type { PermissionsRequest } from '../commands/repl-commands.js';
import { sanitizeInline } from '../render/sanitize.js';
import { findOnPath } from '../engine/find-on-path.js';
import { UNNAMED_PROGRAM, namedProgram, type CommandGrantStore } from './command-grants.js';

/**
 * `/permissions` in the chat ([ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2):
 * the commands remembered for this project and the ones approved for this session, and withdrawing one by its number. It speaks
 * the same labels as `relavium permissions` — a program's name (only when it could be named without risking a credential), the
 * argument count and, for a remembered one, the date — and never a command's arguments. It returns the notice to show; it writes
 * nothing to a terminal itself, so it cannot print anything it did not build here.
 */

/** What `/permissions` needs of the session's approvals: list them and take one back. */
export interface SessionCommandApprovals {
  readonly commandApprovals: () => readonly SessionCommandApproval[];
  readonly forgetCommandApproval: (index: number) => SessionCommandApproval | undefined;
  /** Take back the session approvals a Remember created for this remembered grant; how many were withdrawn. */
  readonly forgetCommandsByGrant?: (grantId: string) => number;
}

export interface ChatPermissionsDeps {
  /** The project's remembered grants, `undefined` where the chat has none (no operator home, or a surface that cannot ask). */
  readonly grants: Pick<CommandGrantStore, 'list' | 'revoke'> | undefined;
  readonly session: SessionCommandApprovals;
  /** Resolve a bare program name on the PATH. Injected so a test needs no real PATH. */
  readonly findProgram?: (name: string) => Promise<string | undefined>;
}

/** The number a person types: a plain decimal from 1, at most six digits. */
const NUMBER = /^[1-9][0-9]{0,5}$/u;

const USAGE =
  'Usage: /permissions lists · /permissions --revoke <number> withdraws a remembered command · /permissions --revoke --session <number> withdraws a session approval.';

const plural = (count: number): string =>
  `${String(count)} ${count === 1 ? 'argument' : 'arguments'}`;

async function sessionLabel(
  argv: readonly string[],
  findProgram: (name: string) => Promise<string | undefined>,
): Promise<string> {
  return `${sanitizeInline((await namedProgram(argv[0], findProgram)) ?? UNNAMED_PROGRAM)}, ${plural(Math.max(0, argv.length - 1))}`;
}

const PROJECT_FAILURES: Readonly<Record<string, string>> = {
  'no-key': 'The OS keychain is not available, so the remembered commands cannot be read.',
  unreadable:
    'The remembered-commands file could not be read, so nothing in it is trusted. `relavium permissions revoke --all` removes it.',
  unwritable: 'The remembered-commands file could not be written, so the revoke did not happen.',
  full: 'The remembered-commands file has no room for a revoke. `relavium permissions revoke --all` removes it.',
};

export async function chatPermissionsNotice(
  request: PermissionsRequest,
  deps: ChatPermissionsDeps,
): Promise<string> {
  const findProgram = deps.findProgram ?? findOnPath;
  // A typo is reported, never quietly turned into a list: `/permissions --revokee 2` must not look like it worked.
  if (
    request.unknown.length > 0 ||
    (!request.revoke && (request.session || request.number !== undefined))
  )
    return USAGE;
  if (request.revoke) return revoke(request, deps, findProgram);
  const lines: string[] = [];
  if (deps.grants === undefined) {
    lines.push('Remembered for this project: not available in this chat.');
  } else {
    const listed = deps.grants.list();
    if (!listed.ok) {
      lines.push(PROJECT_FAILURES[listed.reason] ?? 'The remembered commands could not be read.');
    } else {
      lines.push(
        listed.grants.length === 0
          ? 'Remembered for this project: none.'
          : `Remembered for this project (${String(listed.grants.length)}):`,
      );
      for (const grant of listed.grants)
        lines.push(
          `  ${String(grant.index)}. ${sanitizeInline(grant.program)}  (${plural(grant.args)})  remembered ${sanitizeInline(grant.grantedAt)}`,
        );
    }
  }
  const session = deps.session.commandApprovals();
  lines.push(
    session.length === 0
      ? 'Approved for this session: none.'
      : `Approved for this session (${String(session.length)}):`,
  );
  // An entry a Remember made is also in the project's list above, which is why withdrawing it here can change less than it says.
  for (const [offset, approval] of session.entries())
    lines.push(
      `  ${String(offset + 1)}. ${await sessionLabel(approval.argv, findProgram)}${approval.remembered ? '  (also remembered)' : ''}`,
    );
  lines.push(
    'Withdraw one with /permissions --revoke <number>, or /permissions --revoke --session <number> for a session approval.',
  );
  return lines.join('\n');
}

async function revoke(
  request: PermissionsRequest,
  deps: ChatPermissionsDeps,
  findProgram: (name: string) => Promise<string | undefined>,
): Promise<string> {
  if (request.number === undefined || !NUMBER.test(request.number))
    return 'Give the number to withdraw: /permissions --revoke <number> (or --session <number>). /permissions lists them.';
  const number = Number(request.number);
  if (request.session) {
    const gone = deps.session.forgetCommandApproval(number);
    if (gone === undefined)
      return 'There is no session approval with that number. /permissions lists them.';
    // A session approval a Remember made sits next to a project grant: `auto` still runs the command unasked on that grant.
    const still = gone.remembered
      ? ' It is also remembered for this project, so auto mode still runs it unasked: /permissions --revoke <number> withdraws that.'
      : '';
    return `Withdrew session approval ${String(number)}: ${await sessionLabel(gone.argv, findProgram)}. It asks again.${still} The numbers have changed: /permissions lists them.`;
  }
  if (deps.grants === undefined) return 'Remembered commands are not available in this chat.';
  const result = deps.grants.revoke(number);
  if (result.ok) {
    // A Remember in this chat also left a session approval; it goes with the grant, or the command would keep running unasked.
    let dropped = 0;
    for (const id of result.ids) dropped += deps.session.forgetCommandsByGrant?.(id) ?? 0;
    return `Revoked remembered command ${String(number)}: ${sanitizeInline(result.program)}, ${plural(result.args)}.${dropped > 0 ? ' This chat’s session approval of it went too.' : ''} It asks again the next time it is needed; another chat that is already open keeps its own session approval of it until it withdraws that with /permissions --revoke --session. The numbers have changed: /permissions lists them.`;
  }
  if (result.reason === 'no-such-grant')
    return 'There is no remembered command with that number. /permissions lists them.';
  return PROJECT_FAILURES[result.reason] ?? 'The revoke did not happen.';
}
