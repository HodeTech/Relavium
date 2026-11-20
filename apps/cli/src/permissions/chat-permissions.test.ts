import { describe, expect, it, vi } from 'vitest';

import { ApprovalCache } from '../chat/chat-mode.js';
import {
  createPermissionsPort,
  NOT_AVAILABLE,
  PROJECT_FAILURES,
  readPermissions,
  withdrawProjectGrant,
  withdrawSessionApproval,
  type PermissionsDeps,
} from './chat-permissions.js';
import type { CommandGrantStore, ListResult, RevokeResult } from './command-grants.js';

/** The `/permissions` sheet's data (ADR-0137 §2): the project's remembered commands and this session's approvals, and taking one back. */
type Grants = Pick<CommandGrantStore, 'list' | 'revokeById' | 'matches'>;

function deps(options: {
  readonly list?: ListResult;
  readonly revokeById?: RevokeResult;
  readonly noStore?: boolean;
  readonly matches?: (argv: readonly string[]) => boolean;
  readonly session?: readonly (readonly string[])[];
  /** Session approvals created by a Remember, each linked to the id of the grant it came from. */
  readonly linked?: readonly { readonly argv: readonly string[]; readonly grantId: string }[];
}): PermissionsDeps & {
  readonly cache: ApprovalCache;
  readonly revokeById: ReturnType<typeof vi.fn>;
} {
  const cache = new ApprovalCache();
  for (const argv of options.session ?? []) cache.rememberAlwaysCommand(argv);
  for (const { argv, grantId } of options.linked ?? []) cache.rememberAlwaysCommand(argv, grantId);
  const revokeById = vi.fn(
    () =>
      options.revokeById ??
      ({ ok: true, id: 'a', ids: ['a'], program: 'npm', args: 1 } satisfies RevokeResult),
  );
  const grants: Grants = {
    list: () => options.list ?? { ok: true, grants: [] },
    revokeById,
    matches: options.matches ?? (() => false),
  };
  return {
    grants: options.noStore === true ? undefined : grants,
    session: cache,
    cache,
    revokeById,
  };
}

const GRANTS: ListResult = {
  ok: true,
  grants: [
    { index: 1, id: 'a', program: 'npm', args: 1, grantedAt: '2026-11-19T12:00:07.123Z' },
    {
      index: 2,
      id: 'b',
      program: '(unnamed program)',
      args: 3,
      grantedAt: '2026-11-19T12:05:00.000Z',
    },
  ],
};

describe('readPermissions', () => {
  it('lists the remembered commands by label and minute, and never an argument', () => {
    const snapshot = readPermissions(deps({ list: GRANTS }));
    expect(snapshot.project).toEqual({
      ok: true,
      rows: [
        { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' },
        { id: 'b', label: '(unnamed program), 3 arguments', remembered: '2026-11-19 12:05Z' },
      ],
    });
  });

  it('shows a session approval as the command the card showed, scrubbed, and marks one a remembered grant covers', () => {
    const d = deps({
      session: [['git', 'push', 'origin', 'main']],
      linked: [{ argv: ['npm', 'test'], grantId: 'a' }],
      matches: (argv) => argv[0] === 'npm' || argv[0] === 'curl',
    });
    d.cache.rememberAlwaysCommand(['curl', 'https://x.test']);
    const rows = readPermissions(d).session ?? [];
    expect(rows.map((row) => [row.text, row.alsoRemembered])).toEqual([
      ['git push origin main', false],
      ['npm test', true],
      ['curl https://x.test', true],
    ]);
  });

  it('masks a secret-shaped argument in a session row, as the card’s title does', () => {
    const rows =
      readPermissions(
        deps({
          session: [['psql', 'password=hunter2']],
        }),
      ).session ?? [];
    expect(rows[0]?.text).not.toContain('hunter2');
    expect(rows[0]?.text).toContain('[redacted]');
  });

  it('has no session list on a surface with no chat', () => {
    const d = deps({ list: GRANTS });
    expect(readPermissions({ grants: d.grants, session: undefined }).session).toBeUndefined();
  });

  it('says why when the store cannot answer, and that a chat with no store has none', () => {
    for (const reason of ['no-key', 'unreadable'] as const) {
      expect(readPermissions(deps({ list: { ok: false, reason } })).project).toEqual({
        ok: false,
        text: PROJECT_FAILURES[reason],
      });
    }
    expect(readPermissions(deps({ noStore: true })).project).toEqual({
      ok: false,
      text: NOT_AVAILABLE,
    });
  });
});

describe('withdrawProjectGrant', () => {
  const row = { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' };

  it('withdraws by the grant’s identity and says what it changes without a mode-blind promise', () => {
    const d = deps({});
    expect(withdrawProjectGrant(row, d)).toBe(
      'Withdrew npm, 1 argument. Auto mode asks about it again.',
    );
    expect(d.revokeById).toHaveBeenCalledWith('a');
  });

  it('takes this chat’s linked session approvals with it, by every record of the grant', () => {
    const d = deps({
      revokeById: { ok: true, id: 'a', ids: ['a', 'a-twin'], program: 'npm', args: 1 },
      linked: [{ argv: ['npm', 'test'], grantId: 'a-twin' }],
    });
    expect(withdrawProjectGrant(row, d)).toBe(
      'Withdrew npm, 1 argument. Auto mode asks about it again. Its session approval went too.',
    );
    expect(d.cache.commandApprovals()).toEqual([]);
  });

  it('says a row that is already gone is already withdrawn', () => {
    const d = deps({ revokeById: { ok: false, reason: 'no-such-grant' } });
    expect(withdrawProjectGrant(row, d)).toBe('That row was already withdrawn.');
  });

  it('says in one short row why a withdrawal could not be written, and changes nothing', () => {
    for (const reason of ['unwritable', 'full', 'unreadable', 'no-key'] as const) {
      const text = withdrawProjectGrant(row, deps({ revokeById: { ok: false, reason } }));
      expect(text.length).toBeLessThanOrEqual(70);
      expect(text).not.toMatch(/withdrew/iu);
    }
  });

  it('refuses where there is no store', () => {
    expect(withdrawProjectGrant(row, deps({ noStore: true }))).toBe(NOT_AVAILABLE);
  });
});

describe('withdrawSessionApproval', () => {
  it('withdraws by the exact argv, so a position that moved cannot name another command', () => {
    const d = deps({
      session: [
        ['cat', 'a b'],
        ['cat', 'a', 'b'],
      ],
    });
    expect(
      withdrawSessionApproval(
        { argv: ['cat', 'a', 'b'], text: 'cat a b', alsoRemembered: false },
        d,
      ),
    ).toBe('Session approval withdrawn. Auto mode asks about it again.');
    expect(d.cache.commandApprovals().map((a) => a.argv)).toEqual([['cat', 'a b']]);
  });

  it('says a remembered grant still runs it unasked, whether the Remember made the approval or an older grant covers it', () => {
    const linked = deps({ linked: [{ argv: ['npm', 'test'], grantId: 'a' }] });
    expect(
      withdrawSessionApproval(
        { argv: ['npm', 'test'], text: 'npm test', alsoRemembered: true },
        linked,
      ),
    ).toBe('Session approval withdrawn. Still remembered: auto mode runs it unasked.');
    const covered = deps({ session: [['npm', 'test']], matches: () => true });
    expect(
      withdrawSessionApproval(
        { argv: ['npm', 'test'], text: 'npm test', alsoRemembered: true },
        covered,
      ),
    ).toBe('Session approval withdrawn. Still remembered: auto mode runs it unasked.');
  });

  it('says a row that is already gone is already withdrawn', () => {
    expect(
      withdrawSessionApproval(
        { argv: ['npm', 'test'], text: 'npm test', alsoRemembered: false },
        deps({}),
      ),
    ).toBe('That row was already withdrawn.');
  });
});

describe('createPermissionsPort', () => {
  it('loads and withdraws through the deps it was given, for the surface it was made for', () => {
    const d = deps({ list: GRANTS, session: [['git', 'status']] });
    const port = createPermissionsPort(d, 'chat');
    expect(port.surface).toBe('chat');
    const snapshot = port.load();
    expect(snapshot.project.ok && snapshot.project.rows).toHaveLength(2);
    const entry = { kind: 'session', row: snapshot.session?.[0] } as const;
    if (entry.row === undefined) throw new Error('expected a session row');
    expect(port.withdraw({ kind: 'session', row: entry.row })).toBe(
      'Session approval withdrawn. Auto mode asks about it again.',
    );
    expect(port.load().session).toEqual([]);
  });
});

describe('ApprovalCache.forgetCommandApproval', () => {
  it('takes back one exact argv and reports what it was, or nothing for one that is not there', () => {
    const cache = new ApprovalCache();
    cache.rememberAlwaysCommand(['cat', 'a b']);
    cache.rememberAlwaysCommand(['cat', 'a', 'b'], 'grant-1');
    expect(cache.forgetCommandApproval(['cat', 'a', 'b'])).toEqual({
      argv: ['cat', 'a', 'b'],
      remembered: true,
    });
    expect(cache.commandApprovals().map((a) => a.argv)).toEqual([['cat', 'a b']]);
    expect(cache.forgetCommandApproval(['cat', 'a', 'b'])).toBeUndefined();
    expect(cache.forgetCommandApproval(['nope'])).toBeUndefined();
  });
});
