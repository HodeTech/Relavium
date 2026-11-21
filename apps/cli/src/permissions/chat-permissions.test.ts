import { describe, expect, it, vi } from 'vitest';

import { ApprovalCache } from '../chat/chat-mode.js';
import {
  createPermissionsPort,
  MAX_ROW_TEXT,
  NOT_AVAILABLE,
  PROJECT_FAILURES,
  readPermissions,
  withdrawProjectGrant,
  withdrawSessionApproval,
  type PermissionsDeps,
  type WithdrawAnswer,
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

  it('shows a session approval as the command the card showed, scrubbed, and marks one a remembered grant covers NOW', () => {
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

  it('does not call an approval remembered because a Remember once made it: the grant may be gone (revoked elsewhere)', () => {
    const d = deps({
      linked: [{ argv: ['npm', 'test'], grantId: 'long-gone' }],
      matches: () => false,
    });
    expect(readPermissions(d).session?.map((row) => row.alsoRemembered)).toEqual([false]);
  });

  it('keeps a control, a bidi override and a tab in a command as the characters they are, for the sheet to make visible: nothing is stripped here', () => {
    const argv = ['echo', 'a\u001b[0mb', 'x\u202Ey', 'a\tb', 'l1\nl2'];
    const text = readPermissions(deps({ session: [argv] })).session?.[0]?.text ?? '';
    for (const raw of ['\u001b', '\u202E', '\t', '\n']) expect(text).toContain(raw);
  });

  it('bounds a command’s row once, at load, so a megabyte argument is not measured on every key', () => {
    const rows =
      readPermissions(deps({ session: [['echo', 'x'.repeat(1_000_000)]] })).session ?? [];
    expect([...(rows[0]?.text ?? '')].length).toBeLessThanOrEqual(MAX_ROW_TEXT);
    expect(rows[0]?.text.endsWith('…')).toBe(true);
    const short = readPermissions(deps({ session: [['ls', '-la']] })).session ?? [];
    expect(short[0]?.text).toBe('ls -la');
  });

  it('keeps a row of exactly 400 characters whole and cuts one of 401 to 400 with an ellipsis', () => {
    const argvOf = (length: number): readonly string[] => ['x'.repeat(length)];
    const exactly = readPermissions(deps({ session: [argvOf(400)] })).session?.[0]?.text ?? '';
    expect([...exactly]).toHaveLength(400);
    expect(exactly.endsWith('…')).toBe(false);
    const over = readPermissions(deps({ session: [argvOf(401)] })).session?.[0]?.text ?? '';
    expect([...over]).toHaveLength(400);
    expect(over.endsWith('…')).toBe(true);
  });

  it('says a store that throws in a sentence, and lets a cache that throws surface to the host, never an empty list that claims nothing is approved', () => {
    const grants = {
      list: () => {
        throw new Error('boom');
      },
      revokeById: () => ({ ok: false, reason: 'no-such-grant' }) as const,
      matches: () => false,
    };
    const withStoreFault = readPermissions({ grants, session: new ApprovalCache() });
    expect(withStoreFault.project).toEqual({
      ok: false,
      text: 'The remembered commands could not be read.',
    });
    expect(withStoreFault.session).toEqual([]);
    const cache = {
      commandApprovals: (): never => {
        throw new Error('boom');
      },
      forgetCommandApproval: () => undefined,
    };
    expect(() => readPermissions({ grants: undefined, session: cache })).toThrow('boom');
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
    expect(PROJECT_FAILURES['unreadable']).toBe(
      'The remembered-commands file could not be read, so nothing in it is trusted. Running relavium permissions revoke --all removes it.',
    );
    expect(PROJECT_FAILURES['no-key']).toBe(
      'The OS keychain is not available, so the remembered commands cannot be read.',
    );
    expect(PROJECT_FAILURES['unwritable']).toBe(
      'The remembered-commands file could not be written, so nothing was withdrawn.',
    );
    expect(PROJECT_FAILURES['full']).toBe(
      'The remembered-commands file has no room for a withdrawal. Running relavium permissions revoke --all removes it.',
    );
    expect(NOT_AVAILABLE).toBe('Remembered commands are not available in this chat.');
    // A terminal shows a backtick as a backtick: the sentences carry none.
    for (const sentence of Object.values(PROJECT_FAILURES)) expect(sentence).not.toContain('`');
    expect(readPermissions(deps({ noStore: true })).project).toEqual({
      ok: false,
      text: NOT_AVAILABLE,
    });
  });
});

const done = (text: string): WithdrawAnswer => ({ tone: 'done', text });
const note = (text: string): WithdrawAnswer => ({ tone: 'note', text });
const failed = (text: string): WithdrawAnswer => ({ tone: 'failed', text });

describe('withdrawProjectGrant', () => {
  const row = { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' };

  it('withdraws by the grant’s identity and says what it changes, in a sentence that fits one row whatever the label', () => {
    const d = deps({});
    expect(withdrawProjectGrant(row, d)).toEqual(done('Withdrawn. Auto mode asks about it again.'));
    expect(d.revokeById).toHaveBeenCalledWith('a');
  });

  it('takes this chat’s linked session approvals with it, by every record of the grant', () => {
    const d = deps({
      revokeById: { ok: true, id: 'a', ids: ['a', 'a-twin'], program: 'npm', args: 1 },
      linked: [{ argv: ['npm', 'test'], grantId: 'a-twin' }],
    });
    expect(withdrawProjectGrant(row, d)).toEqual(
      done('Withdrawn, with its session approval. It needs approval again.'),
    );
    expect(d.cache.commandApprovals()).toEqual([]);
  });

  it('does not promise a question while a plain session approval of the same command still stands: it runs unasked in every mode', () => {
    const covered = new Set(['npm test']);
    const d = deps({ session: [['npm', 'test']], matches: (argv) => covered.has(argv.join(' ')) });
    d.revokeById.mockImplementation(() => {
      covered.clear(); // the grant is gone once the revoke has run
      return { ok: true, id: 'a', ids: ['a'], program: 'npm', args: 1 };
    });
    expect(withdrawProjectGrant(row, d)).toEqual(
      note('Withdrawn, but a session approval of it remains: it is still approved here.'),
    );
    expect(d.cache.commandApprovals().map((a) => a.argv)).toEqual([['npm', 'test']]);
  });

  it('does not claim a session approval remains when it belongs to ANOTHER remembered command: only the approvals this grant covered count (security sitting 2, M2)', () => {
    // Two grants: A (npm test), withdrawn here; B (git status), with its own approval in this chat. B's approval matches before and after.
    const live = new Set(['npm test', 'git status']);
    const d = deps({
      linked: [{ argv: ['git', 'status'], grantId: 'b' }],
      matches: (argv) => live.has(argv.join(' ')),
    });
    d.revokeById.mockImplementation(() => {
      live.delete('npm test');
      return { ok: true, id: 'a', ids: ['a'], program: 'npm', args: 1 };
    });
    expect(withdrawProjectGrant(row, d)).toEqual(done('Withdrawn. Auto mode asks about it again.'));
    expect(d.cache.commandApprovals().map((a) => a.argv)).toEqual([['git', 'status']]);
    // And with a plain approval of A's own command standing beside B's, the answer does say so.
    const live2 = new Set(['npm test', 'git status']);
    const d2 = deps({
      session: [['npm', 'test']],
      linked: [{ argv: ['git', 'status'], grantId: 'b' }],
      matches: (argv) => live2.has(argv.join(' ')),
    });
    d2.revokeById.mockImplementation(() => {
      live2.delete('npm test');
      return { ok: true, id: 'a', ids: ['a'], program: 'npm', args: 1 };
    });
    expect(withdrawProjectGrant(row, d2)).toEqual(
      note('Withdrawn, but a session approval of it remains: it is still approved here.'),
    );
  });

  it('an unrelated plain approval is not reported as remaining when the covered approval went with its grant', () => {
    // The grant of `npm test` had a linked session approval (dropped with it); `git status` has an approval of its own, covered by nothing.
    const live = new Set(['npm test']);
    const d = deps({
      linked: [{ argv: ['npm', 'test'], grantId: 'a' }],
      session: [['git', 'status']],
      matches: (argv) => live.has(argv.join(' ')),
    });
    d.revokeById.mockImplementation(() => {
      live.clear();
      return { ok: true, id: 'a', ids: ['a'], program: 'npm', args: 1 };
    });
    expect(withdrawProjectGrant(row, d)).toEqual(
      done('Withdrawn, with its session approval. It needs approval again.'),
    );
    expect(d.cache.commandApprovals().map((a) => a.argv)).toEqual([['git', 'status']]);
  });

  it('compares approvals by every element of the argv: another command’s approval is not "its" approval', () => {
    const live = new Set(['npm test']);
    const d = deps({
      session: [['npm', 'test', '--watch']], // a different argv: not covered by the grant of `npm test`
      matches: (argv) => live.has(argv.join(' ')),
    });
    d.revokeById.mockImplementation(() => {
      live.clear();
      return { ok: true, id: 'a', ids: ['a'], program: 'npm', args: 1 };
    });
    expect(withdrawProjectGrant(row, d)).toEqual(done('Withdrawn. Auto mode asks about it again.'));
  });

  it('an unrelated session approval does not change the answer', () => {
    const d = deps({ session: [['git', 'status']], matches: () => false });
    expect(withdrawProjectGrant(row, d)).toEqual(done('Withdrawn. Auto mode asks about it again.'));
  });

  it('says a row that is already gone is already withdrawn', () => {
    const d = deps({ revokeById: { ok: false, reason: 'no-such-grant' } });
    expect(withdrawProjectGrant(row, d)).toEqual(note('That row was already withdrawn.'));
  });

  it('says in one short row why a withdrawal could not be written, and changes nothing', () => {
    for (const reason of ['unwritable', 'full', 'unreadable', 'no-key'] as const) {
      const answer = withdrawProjectGrant(row, deps({ revokeById: { ok: false, reason } }));
      expect(answer.text.length).toBeLessThanOrEqual(78);
      // a failure is drawn as one: a `✗` in the danger colour, not a note
      expect(answer.tone, reason).toBe('failed');
      expect(answer.text, reason).toBe(
        {
          unwritable: 'Could not write the withdrawal; nothing changed.',
          full: 'No room in the file; relavium permissions revoke --all clears it.',
          unreadable: 'The remembered-commands file could not be read.',
          'no-key': 'The OS keychain is not available.',
        }[reason],
      );
    }
  });

  it('refuses where there is no store', () => {
    expect(withdrawProjectGrant(row, deps({ noStore: true }))).toEqual(failed(NOT_AVAILABLE));
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
    ).toEqual(done('Session approval withdrawn. It needs approval again.'));
    expect(d.cache.commandApprovals().map((a) => a.argv)).toEqual([['cat', 'a b']]);
  });

  it('says it is still remembered only when a remembered grant covers the command now, however the approval came to be', () => {
    const row = { argv: ['npm', 'test'], text: 'npm test', alsoRemembered: true };
    const covered = deps({ session: [['npm', 'test']], matches: () => true });
    expect(withdrawSessionApproval(row, covered)).toEqual(
      note('Session approval withdrawn. It is still remembered: auto mode runs it unasked.'),
    );
    // A Remember's link to a grant that has since been revoked elsewhere proves nothing: no grant covers it now.
    const gone = deps({ linked: [{ argv: ['npm', 'test'], grantId: 'a' }], matches: () => false });
    expect(withdrawSessionApproval(row, gone)).toEqual(
      done('Session approval withdrawn. It needs approval again.'),
    );
  });

  it('asks the store before it forgets anything: a store that fails on the question leaves the approval where it was (security round 1)', () => {
    const d = deps({
      session: [['npm', 'test']],
      matches: () => {
        throw new Error('store failed');
      },
    });
    expect(() =>
      withdrawSessionApproval(
        { argv: ['npm', 'test'], text: 'npm test', alsoRemembered: false },
        d,
      ),
    ).toThrow('store failed');
    expect(d.cache.commandApprovals().map((a) => a.argv)).toEqual([['npm', 'test']]);
  });

  it('says a row that is already gone is already withdrawn', () => {
    expect(
      withdrawSessionApproval(
        { argv: ['npm', 'test'], text: 'npm test', alsoRemembered: false },
        deps({}),
      ),
    ).toEqual(note('That row was already withdrawn.'));
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
    expect(port.withdraw({ kind: 'session', row: entry.row })).toEqual(
      done('Session approval withdrawn. It needs approval again.'),
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
